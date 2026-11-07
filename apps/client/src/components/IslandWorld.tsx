import { useLayoutEffect, useRef, useMemo, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { User } from "@p2p-chat/types";

// ---------------------------------------------------------------------------
// Deterministic-per-load randomness
// ---------------------------------------------------------------------------
// Computed once at module scope so no component render is impure.

/** Per-vertex wave phase for the ocean plane (81 × 81 vertices). */
const OCEAN_PHASES = Float32Array.from({ length: 81 * 81 }, () =>
  Math.random() * Math.PI * 2,
);

/** Ambient particle field parameters. */
const PARTICLES = Array.from({ length: 60 }, () => ({
  x: (Math.random() - 0.5) * 40,
  y: Math.random() * 8 + 1,
  z: (Math.random() - 0.5) * 40,
  speed: 0.3 + Math.random() * 0.5,
  phase: Math.random() * Math.PI * 2,
}));

// ---------------------------------------------------------------------------
// Art direction: one pen, flat fills
// ---------------------------------------------------------------------------
//
// The world is drawn with the same pen as the UI: hard ink outlines, flat
// fills from the same five colours, hard-edged shadows, no glow. Every
// surface is a MeshToonMaterial lit through a three-step ramp, so it resolves
// into flat bands instead of a smooth gradient — a gradient is the one thing
// the rest of the interface never does.

const INK = "#171310";
const CREAM = "#fff9f0";
const CORAL = "#ff5a36";
const MUSTARD = "#ffc145";
const TEAL = "#1f9d8b";

// Tints used for large 3D surfaces, where the full-strength colours would
// swallow the outline drawn around them.
const SAND = "#ffd98a";
const SAND_LIGHT = "#ffe7b8";
const WATER = "#57c4b6";
const FOLIAGE = "#17776a";
const FOLIAGE_LIGHT = "#2aa392";
const STONE = "#c2b3a4";
const STONE_DARK = "#93867a";

/** Three flat light bands: shadow, mid, lit. */
const TOON_RAMP = (() => {
  const steps = new Uint8Array([110, 185, 250]);
  const texture = new THREE.DataTexture(
    steps,
    steps.length,
    1,
    THREE.RedFormat,
  );
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
})();

/**
 * Stroke width for every silhouette, as a fraction of half the viewport width
 * — so a 2px stroke in CSS pixels regardless of display density or distance.
 */
const INK_WIDTH = 0.005;

/**
 * Inverted-hull outline.
 *
 * drei's <Outlines> draws nothing in this stack (drei 10.7.7 / three 0.182 /
 * R3F 9.8): the hull is created, but no pixels reach the screen, and neither
 * its creased-normals path nor its thickness value is the cause. Rather than
 * keep guessing at an opaque dependency, this is the same technique written
 * out: render the geometry again with back faces only, each vertex pushed
 * along its normal by a constant number of screen pixels.
 *
 * Because the offset is applied in clip space *before* the perspective divide
 * and multiplied by w, it cancels out to a constant on-screen width — the
 * equivalent of the UI's 2px border, whatever the object's size or distance.
 */
const OUTLINE_VERTEX = /* glsl */ `
  uniform float uWidth;
  void main() {
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * normal);
    clip.xy += n.xy * uWidth * clip.w;
    gl_Position = clip;
  }
`;

const OUTLINE_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  void main() {
    gl_FragColor = vec4(uColor, 1.0);
  }
`;

/** Renders the parent mesh's geometry again as an ink silhouette. */
function InkOutline({ width = INK_WIDTH }: { width?: number }) {
  const ref = useRef<THREE.Mesh>(null);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        uniforms: {
          uWidth: { value: width },
          uColor: { value: new THREE.Color(INK) },
        },
        vertexShader: OUTLINE_VERTEX,
        fragmentShader: OUTLINE_FRAGMENT,
      }),
    [width],
  );

  // Borrow the parent mesh's geometry rather than duplicating it.
  useLayoutEffect(() => {
    const parent = ref.current?.parent as THREE.Mesh | undefined;
    if (ref.current && parent?.geometry) ref.current.geometry = parent.geometry;
  });

  return <mesh ref={ref} material={material} />;
}

interface IslandWorldProps {
  users: User[];
  myId: string;
  myPosition: [number, number, number];
  myColor: string;
  onAvatarClick: (userId: string) => void;
}

// ---------------------------------------------------------------------------
// Ocean – animated low-poly water plane
// ---------------------------------------------------------------------------

/** A large low-poly plane with gentle vertex-based wave animation. */
function Ocean() {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    const geo = meshRef.current.geometry as THREE.PlaneGeometry;
    const pos = geo.attributes.position;
    const t = clock.elapsedTime;

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      // Small wave displacement on the Z axis (plane is rotated -90° on X)
      pos.setZ(
        i,
        Math.sin(x * 0.3 + t * 0.6 + OCEAN_PHASES[i % OCEAN_PHASES.length]) *
          0.15 +
          Math.cos(y * 0.25 + t * 0.4) * 0.1,
      );
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  });

  return (
    <mesh
      ref={meshRef}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -2.4, 0]}
      receiveShadow
    >
      <planeGeometry args={[120, 120, 80, 80]} />
      {/* Opaque, unlike the previous 85%-transparent version: a full-screen
          transparent surface forces depth sorting every frame, and flat water
          is the point. The toon ramp turns the wave normals into facets. */}
      <meshToonMaterial
        color={WATER}
        gradientMap={TOON_RAMP}
        flatShading
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Low-poly tree decoration
// ---------------------------------------------------------------------------

function LowPolyTree({
  position,
  scale = 1,
}: {
  position: [number, number, number];
  scale?: number;
}) {
  return (
    <group position={position} scale={scale}>
      {/* Trunk */}
      <mesh position={[0, 0.3, 0]} castShadow>
        <cylinderGeometry args={[0.08, 0.12, 0.6, 5]} />
        <meshToonMaterial
          color={STONE_DARK}
          gradientMap={TOON_RAMP}
          flatShading
        />
        <InkOutline />
      </mesh>
      {/* Canopy – stacked low-poly cones */}
      <mesh position={[0, 0.85, 0]} castShadow>
        <coneGeometry args={[0.45, 0.7, 6]} />
        <meshToonMaterial
          color={FOLIAGE}
          gradientMap={TOON_RAMP}
          flatShading
        />
        <InkOutline />
      </mesh>
      <mesh position={[0, 1.2, 0]} castShadow>
        <coneGeometry args={[0.32, 0.55, 6]} />
        <meshToonMaterial
          color={FOLIAGE_LIGHT}
          gradientMap={TOON_RAMP}
          flatShading
        />
        <InkOutline />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Low-poly rock decoration
// ---------------------------------------------------------------------------

function LowPolyRock({
  position,
  scale = 1,
  color = STONE,
}: {
  position: [number, number, number];
  scale?: number;
  color?: string;
}) {
  return (
    <mesh position={position} scale={scale} castShadow>
      <dodecahedronGeometry args={[0.25, 0]} />
      <meshToonMaterial color={color} gradientMap={TOON_RAMP} flatShading />
      <InkOutline />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Island – low-poly floating island with optional decorations
// ---------------------------------------------------------------------------

interface IslandConfig {
  position: [number, number, number];
  color: string;
  radiusTop?: number;
  radiusBottom?: number;
  height?: number;
  segments?: number;
  /** Speed multiplier for the bobbing animation */
  bobSpeed?: number;
  trees?: [number, number, number][];
  rocks?: { pos: [number, number, number]; scale?: number; color?: string }[];
}

function Island({ config }: { config: IslandConfig }) {
  const {
    position,
    color,
    radiusTop = 3,
    radiusBottom = 2.5,
    height = 1,
    segments = 7,
    bobSpeed = 0.5,
    trees = [],
    rocks = [],
  } = config;

  const groupRef = useRef<THREE.Group>(null);

  // Independent gentle bob
  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    groupRef.current.position.y =
      position[1] + Math.sin(clock.elapsedTime * bobSpeed) * 0.2;
  });

  return (
    <group ref={groupRef} position={position}>
      {/* Main island body */}
      <mesh castShadow receiveShadow>
        <cylinderGeometry args={[radiusTop, radiusBottom, height, segments]} />
        <meshToonMaterial color={color} gradientMap={TOON_RAMP} flatShading />
        <InkOutline />
      </mesh>

      {/* Grass/top layer — slightly wider disc on top */}
      <mesh position={[0, height / 2 + 0.02, 0]} receiveShadow>
        <cylinderGeometry
          args={[radiusTop * 1.02, radiusTop, 0.08, segments]}
        />
        <meshToonMaterial
          color={SAND_LIGHT}
          gradientMap={TOON_RAMP}
          flatShading
        />
        <InkOutline />
      </mesh>

      {/* Bottom underside — darker layer for depth */}
      <mesh position={[0, -height / 2 - 0.15, 0]}>
        <cylinderGeometry
          args={[radiusBottom, radiusBottom * 0.6, 0.3, segments]}
        />
        <meshToonMaterial
          color={STONE_DARK}
          gradientMap={TOON_RAMP}
          flatShading
        />
        <InkOutline />
      </mesh>

      {/* Decorative trees */}
      {trees.map((treePos, i) => (
        <LowPolyTree
          key={`tree-${i}`}
          position={[treePos[0], height / 2 + 0.04, treePos[2]]}
          scale={treePos[1]}
        />
      ))}

      {/* Decorative rocks */}
      {rocks.map((rock, i) => (
        <LowPolyRock
          key={`rock-${i}`}
          position={[rock.pos[0], height / 2 + 0.15, rock.pos[2]]}
          scale={rock.scale}
          color={rock.color}
        />
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Availability ring – flat ink ring marking who can be invited
// ---------------------------------------------------------------------------

function AvailabilityRing({ available }: { available: boolean }) {
  return (
    <mesh position={[0, -0.32, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.42, 0.52, 28]} />
      <meshBasicMaterial
        color={available ? TEAL : STONE}
        transparent
        opacity={available ? 0.95 : 0.5}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Avatar – user sphere with label, idle bounce, and click handling
// ---------------------------------------------------------------------------

function Avatar({
  position,
  color,
  id,
  isLocal = false,
  available = true,
  onClick,
}: {
  position: [number, number, number];
  color: string;
  id: string;
  isLocal?: boolean;
  available?: boolean;
  onClick?: () => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const [hovered, setHovered] = useState(false);

  // Idle bounce, plus a lift while hovered so the click target reads as
  // pressable without an emissive glow.
  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    const bounce = Math.sin(clock.elapsedTime * 2 + position[0]) * 0.1;
    groupRef.current.position.y = position[1] + bounce + (hovered ? 0.12 : 0);
  });

  return (
    <group ref={groupRef} position={position}>
      <AvailabilityRing available={isLocal ? true : available} />

      {/* Avatar sphere */}
      <mesh
        castShadow
        scale={hovered ? 1.12 : 1}
        onClick={(e) => {
          e.stopPropagation();
          if (!isLocal && onClick) onClick();
        }}
        onPointerOver={(e) => {
          if (isLocal) return;
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = "default";
        }}
      >
        <sphereGeometry args={[0.35, 14, 14]} />
        <meshToonMaterial color={color} gradientMap={TOON_RAMP} flatShading />
        <InkOutline />
      </mesh>

      {/* Floating name label.
          Rendered as DOM rather than troika text: troika builds its renderer in
          a blob-URL worker, and under a Content-Security-Policy that worker
          fails silently, which leaves the font promise pending and suspends this
          component — taking the entire scene with it. DOM labels need neither a
          worker nor a font fetch, so the CSP can stay strict. */}
      <Html
        center
        position={[0, 0.68, 0]}
        distanceFactor={11}
        zIndexRange={[10, 0]}
        style={{ pointerEvents: "none" }}
      >
        <span
          className={`whitespace-nowrap rounded-full border-2 border-ink px-3 py-1 text-[12px] font-extrabold tracking-tight shadow-[2px_2px_0_var(--color-ink)] ${
            isLocal ? "bg-mustard text-ink" : "bg-cream text-ink"
          }`}
        >
          {isLocal ? "You" : id.slice(0, 6)}
        </span>
      </Html>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Ambient floating particles
// ---------------------------------------------------------------------------

function Particles({ count = 60 }: { count?: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  const data = useMemo(() => PARTICLES.slice(0, count), [count]);

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.elapsedTime;
    data.forEach((p, i) => {
      dummy.position.set(
        p.x + Math.sin(t * p.speed + p.phase) * 0.5,
        p.y + Math.sin(t * p.speed * 1.3 + p.phase) * 0.8,
        p.z + Math.cos(t * p.speed + p.phase) * 0.5,
      );
      dummy.scale.setScalar(0.04 + Math.sin(t * 2 + p.phase) * 0.02);
      dummy.updateMatrix();
      ref.current!.setMatrixAt(i, dummy.matrix);
    });
    ref.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]}>
      <sphereGeometry args={[1, 6, 6]} />
      <meshBasicMaterial color={CREAM} transparent opacity={0.75} />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// Island presets – positions, decorations, and visual variety
// ---------------------------------------------------------------------------
//
// Colours are drawn only from the UI palette (plus two warm-grey neutrals).
// The previous six-pastel scheme shared nothing with the chrome: nothing else
// in the product was purple, amber or sky blue.

const ISLANDS: IslandConfig[] = [
  {
    // Center island – largest, sand
    position: [0, -1.5, 0],
    color: SAND,
    radiusTop: 6.2,
    radiusBottom: 4.8,
    height: 1.6,
    segments: 8,
    bobSpeed: 0.35,
    trees: [
      [-1.5, 1, -0.8],
      [1.2, 0.8, 1],
      [0.3, 1.2, -1.5],
    ],
    rocks: [
      { pos: [2, 0, -1.2], scale: 1 },
      { pos: [-2.2, 0, 0.8], scale: 0.7, color: CORAL },
    ],
  },
  {
    // Coral island – north-east
    position: [9, -1, -6],
    color: CORAL,
    radiusTop: 1.8,
    radiusBottom: 1.4,
    height: 0.65,
    segments: 6,
    bobSpeed: 0.45,
    trees: [
      [0.6, 0.9, -0.4],
      [-0.8, 0.7, 0.5],
    ],
    rocks: [{ pos: [1.5, 0, 0.6], scale: 0.8, color: STONE_DARK }],
  },
  {
    // Mustard island – south-west
    position: [-8, -1.2, 5],
    color: MUSTARD,
    radiusTop: 1.9,
    radiusBottom: 1.5,
    height: 0.68,
    segments: 7,
    bobSpeed: 0.55,
    trees: [[0, 1.1, 0]],
    rocks: [
      { pos: [-1.8, 0, -0.5], scale: 1.1 },
      { pos: [1.3, 0, 1], scale: 0.6, color: CORAL },
    ],
  },
  {
    // Cream island – south-east
    position: [6, -0.8, 7],
    color: CREAM,
    radiusTop: 1.6,
    radiusBottom: 1.2,
    height: 0.62,
    segments: 6,
    bobSpeed: 0.5,
    trees: [[-0.5, 0.75, 0.3]],
    rocks: [{ pos: [1, 0, -0.4], scale: 0.7, color: STONE_DARK }],
  },
  {
    // Teal island – north-west
    position: [-7, -0.9, -7],
    color: TEAL,
    radiusTop: 1.7,
    radiusBottom: 1.3,
    height: 0.62,
    segments: 7,
    bobSpeed: 0.4,
    trees: [
      [0.8, 0.85, -0.3],
      [-0.5, 1, 0.6],
    ],
    rocks: [],
  },
  {
    // Small cream stepping stone
    position: [3, -1.6, -3],
    color: CREAM,
    radiusTop: 1.2,
    radiusBottom: 0.9,
    height: 0.48,
    segments: 6,
    bobSpeed: 0.6,
    trees: [],
    rocks: [{ pos: [0.5, 0, 0.2], scale: 0.5, color: STONE }],
  },
  {
    // Additional tiny islands
    position: [11, -1.2, 1],
    color: SAND,
    radiusTop: 1.1,
    radiusBottom: 0.8,
    height: 0.42,
    segments: 6,
    bobSpeed: 0.62,
    trees: [],
    rocks: [{ pos: [0.25, 0, 0.2], scale: 0.45 }],
  },
  {
    position: [0, -1.4, 10],
    color: MUSTARD,
    radiusTop: 1,
    radiusBottom: 0.75,
    height: 0.4,
    segments: 6,
    bobSpeed: 0.58,
    trees: [],
    rocks: [],
  },
  {
    position: [-11, -1.15, 0],
    color: CORAL,
    radiusTop: 1.15,
    radiusBottom: 0.82,
    height: 0.44,
    segments: 6,
    bobSpeed: 0.63,
    trees: [],
    rocks: [{ pos: [0.2, 0, -0.2], scale: 0.4 }],
  },
  {
    position: [8, -1.3, 9],
    color: TEAL,
    radiusTop: 0.95,
    radiusBottom: 0.7,
    height: 0.36,
    segments: 6,
    bobSpeed: 0.67,
    trees: [],
    rocks: [],
  },
  {
    position: [-9, -1.35, 8],
    color: CREAM,
    radiusTop: 1,
    radiusBottom: 0.72,
    height: 0.38,
    segments: 6,
    bobSpeed: 0.64,
    trees: [],
    rocks: [],
  },
  {
    position: [9, -1.25, -9],
    color: SAND,
    radiusTop: 0.9,
    radiusBottom: 0.65,
    height: 0.34,
    segments: 6,
    bobSpeed: 0.7,
    trees: [],
    rocks: [],
  },
  {
    position: [-10, -1.3, -9],
    color: MUSTARD,
    radiusTop: 1.05,
    radiusBottom: 0.74,
    height: 0.4,
    segments: 6,
    bobSpeed: 0.66,
    trees: [],
    rocks: [{ pos: [0.3, 0, 0], scale: 0.42 }],
  },
];

// ---------------------------------------------------------------------------
// Main scene component
// ---------------------------------------------------------------------------

export function IslandWorld({
  users,
  myId,
  myPosition,
  myColor,
  onAvatarClick,
}: IslandWorldProps) {
  const centerIsland = ISLANDS[0];
  const centerSurfaceY =
    centerIsland.position[1] + (centerIsland.height ?? 1) / 2 + 0.5;
  const remoteUsers = users.filter((u) => u.id !== myId);
  const remoteAvatarPositions = useMemo(() => {
    return remoteUsers.map((_, index) => {
      const perRing = 8;
      const ring = Math.floor(index / perRing);
      const indexInRing = index % perRing;
      const angle = (indexInRing / perRing) * Math.PI * 2 + ring * 0.35;
      const radius = 1.8 + ring * 0.9;

      return [
        centerIsland.position[0] + Math.cos(angle) * radius,
        centerSurfaceY,
        centerIsland.position[2] + Math.sin(angle) * radius,
      ] as [number, number, number];
    });
  }, [remoteUsers, centerIsland.position, centerSurfaceY]);

  const localAvatarPosition: [number, number, number] = [
    centerIsland.position[0],
    centerSurfaceY,
    centerIsland.position[2],
  ];

  void myPosition;

  return (
    <div className="w-full h-screen">
      <Canvas
        shadows="percentage"
        camera={{ position: [12, 10, 12], fov: 55 }}
        style={{
          // Cream paper instead of a sky gradient: the scene sits on the same
          // surface as the UI rather than floating in a different one.
          background: `linear-gradient(to bottom, ${CREAM} 0%, #f6ead6 100%)`,
        }}
      >
        {/* ---- Lighting ---- */}
        {/* Flatter than before on purpose: toon bands need even fill, and the
            old 1.2-intensity key light produced soft gradients. */}
        <ambientLight intensity={0.85} />
        <directionalLight
          position={[15, 20, 10]}
          intensity={0.75}
          castShadow
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
          shadow-camera-left={-20}
          shadow-camera-right={20}
          shadow-camera-top={20}
          shadow-camera-bottom={-20}
          shadow-camera-near={0.5}
          shadow-camera-far={60}
        />

        {/* ---- Fog for depth / horizon blend ---- */}
        <fog attach="fog" args={[CREAM, 26, 70]} />

        {/* ---- Camera controls ---- */}
        <OrbitControls
          enablePan
          enableZoom
          enableRotate
          minDistance={6}
          maxDistance={30}
          maxPolarAngle={Math.PI / 2.1}
          target={[0, 0, 0]}
        />

        {/* ---- Ocean ---- */}
        <Ocean />

        {/* ---- Islands ---- */}
        {ISLANDS.map((island, i) => (
          <Island key={`island-${i}`} config={island} />
        ))}

        {/* ---- Local user avatar ---- */}
        <Avatar
          position={localAvatarPosition}
          color={myColor}
          id={myId}
          isLocal
          available
        />

        {/* ---- Remote user avatars ---- */}
        {remoteUsers.map((user, index) => (
          <Avatar
            key={user.id}
            position={remoteAvatarPositions[index]}
            color={user.color}
            id={user.id}
            available={user.available}
            onClick={() => onAvatarClick(user.id)}
          />
        ))}

        {/* ---- Ambient floating particles ---- */}
        <Particles count={60} />
      </Canvas>
    </div>
  );
}
