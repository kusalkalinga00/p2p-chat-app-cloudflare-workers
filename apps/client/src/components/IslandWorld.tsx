import { useLayoutEffect, useRef, useMemo, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { User } from "@p2p-chat/types";

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
const TEAL = "#1f9d8b";

// Tints for large 3D surfaces, where the full-strength colours would swallow
// the outline drawn around them.
const SAND = "#ffd98a";
const SAND_MID = "#f2c072";
const WATER = "#57c4b6";
const FOLIAGE = "#17776a";
const FOLIAGE_LIGHT = "#2aa392";
const TRUNK = "#b98a5f";
const COCONUT = "#c98a5f";
const STONE = "#c2b3a4";

/** Height of the sea surface. Everything else is positioned against it. */
const WATER_Y = -2.4;

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

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

/** Small deterministic PRNG, so a reload produces the same archipelago. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Shoreline = { k: number; amp: number; phase: number }[];

/**
 * An irregular coastline, as a sum of harmonics of the angle around the
 * island. Because it is a pure function of the angle, the side walls, the top
 * cap and the foam ring all agree on the silhouette without sharing indices.
 */
function makeShoreline(seed: number, wobble = 1): Shoreline {
  const rnd = mulberry32(seed);
  return [
    {
      k: 3 + Math.floor(rnd() * 3),
      amp: (0.10 + rnd() * 0.09) * wobble,
      phase: rnd() * Math.PI * 2,
    },
    {
      k: 6 + Math.floor(rnd() * 4),
      amp: (0.05 + rnd() * 0.05) * wobble,
      phase: rnd() * Math.PI * 2,
    },
    {
      k: 11 + Math.floor(rnd() * 5),
      amp: (0.02 + rnd() * 0.03) * wobble,
      phase: rnd() * Math.PI * 2,
    },
  ];
}

function shoreFactor(shore: Shoreline, angle: number) {
  let f = 1;
  for (const h of shore) f += h.amp * Math.sin(h.k * angle + h.phase);
  return f;
}

// ---------------------------------------------------------------------------
// Ink outline — inverted hull
// ---------------------------------------------------------------------------
//
// drei's <Outlines> draws nothing in this stack (drei 10.7.7 / three 0.182 /
// R3F 9.8): the hull is created, but no pixels reach the screen, and neither
// its creased-normals path nor its thickness value is the cause. This is the
// same technique written out: render the geometry again with back faces only,
// each vertex pushed along its normal by a constant number of screen pixels.

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

// ---------------------------------------------------------------------------
// Island geometry — irregular silhouette, seated in the water
// ---------------------------------------------------------------------------

interface IslandGeometry {
  body: THREE.BufferGeometry;
  cap: THREE.BufferGeometry;
  foam: THREE.BufferGeometry;
  shoreline: Shoreline;
  segments: number;
}

/**
 * Builds one island as a ring stack.
 *
 * The previous version was a plain cylinder hovering just above the surface,
 * which read as a floating rock. This profile starts at the sand rim, bulges
 * out at the waterline and keeps going well below it, so the island is a
 * landform standing in the sea rather than a disc in the air. The water is
 * opaque, so the submerged part simply disappears under it.
 */
function buildIsland(
  radius: number,
  topY: number,
  seed: number,
  segments = 11,
): IslandGeometry {
  const shoreline = makeShoreline(seed);
  const bottomY = WATER_Y - (topY - WATER_Y) - 1.6;

  // Sand profile from the rim down: (height fraction, radius scaling).
  // A wide, shallow beach rather than a vertical wall: the flank is what
  // separates "island" from "disc", and a taller rim gives it visible height.
  const levels = [
    { y: topY, r: 1.0 },
    { y: topY - 0.45, r: 1.1 },
    { y: WATER_Y + 0.15, r: 1.24 },
    { y: WATER_Y - 0.8, r: 1.0 },
    { y: bottomY, r: 0.5 },
  ];

  const positions: number[] = [];
  const indices: number[] = [];

  const pushRing = (y: number, rFactor: number) => {
    const start = positions.length / 3;
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      const r = radius * rFactor * shoreFactor(shoreline, angle);
      positions.push(Math.cos(angle) * r, y, Math.sin(angle) * r);
    }
    return start;
  };

  const rings = levels.map((l) => pushRing(l.y, l.r));

  for (let level = 0; level < levels.length - 1; level++) {
    const top = rings[level];
    const bottom = rings[level + 1];
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      // Outward winding verified against the outward normal.
      indices.push(top + i, top + j, bottom + i);
      indices.push(top + j, bottom + j, bottom + i);
    }
  }

  const body = new THREE.BufferGeometry();
  body.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  body.setIndex(indices);
  body.computeVertexNormals();

  // Top surface: a shallow dome rather than a flat disc, so the island reads
  // as a landform instead of a plateau. Centre, an inner ring, and the rim.
  const capPositions: number[] = [0, topY + 0.14, 0];
  const capIndices: number[] = [];

  const innerStart = 1;
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const r = radius * 0.52 * shoreFactor(shoreline, angle);
    capPositions.push(
      Math.cos(angle) * r,
      topY + 0.06,
      Math.sin(angle) * r,
    );
  }

  const rimStart = innerStart + segments;
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const r = radius * shoreFactor(shoreline, angle);
    capPositions.push(Math.cos(angle) * r, topY, Math.sin(angle) * r);
  }

  for (let i = 0; i < segments; i++) {
    const a = innerStart + i;
    const b = innerStart + ((i + 1) % segments);
    // Centre fan to the inner ring.
    capIndices.push(0, b, a);
    // Sloped band between the inner ring and the rim.
    const ra = rimStart + i;
    const rb = rimStart + ((i + 1) % segments);
    capIndices.push(a, b, rb);
    capIndices.push(a, rb, ra);
  }
  const cap = new THREE.BufferGeometry();
  cap.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(capPositions, 3),
  );
  cap.setIndex(capIndices);
  cap.computeVertexNormals();

  // Foam ring where the sand meets the sea.
  const foamPositions: number[] = [];
  const foamIndices: number[] = [];
  const inner: number[] = [];
  const outer: number[] = [];
  for (let i = 0; i < segments * 4; i++) {
    const angle = (i / (segments * 4)) * Math.PI * 2;
    const f = shoreline;
    const base = 1.075 * radius * shoreFactor(f, angle);
    inner.push(foamPositions.length / 3);
    foamPositions.push(Math.cos(angle) * base, WATER_Y + 0.05, Math.sin(angle) * base);
    outer.push(foamPositions.length / 3);
    foamPositions.push(
      Math.cos(angle) * base * 1.16,
      WATER_Y + 0.05,
      Math.sin(angle) * base * 1.16,
    );
  }
  for (let i = 0; i < segments * 4; i++) {
    const n = (i + 1) % (segments * 4);
    foamIndices.push(inner[i], outer[i], inner[n]);
    foamIndices.push(inner[n], outer[i], outer[n]);
  }
  const foam = new THREE.BufferGeometry();
  foam.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(foamPositions, 3),
  );
  foam.setIndex(foamIndices);
  foam.computeVertexNormals();

  return { body, cap, foam, shoreline, segments };
}

// ---------------------------------------------------------------------------
// Ocean – displaced low-poly water with drifting foam crests
// ---------------------------------------------------------------------------

/**
 * Uniform holders shared with the patched water shader.
 *
 * Module scope rather than useMemo: the React Compiler lint forbids mutating a
 * memoised value after render, and the shader needs the same object identity
 * for the lifetime of the material.
 */
const WATER_UNIFORMS = {
  uTime: { value: 0 },
  uFoam: { value: new THREE.Color(CREAM) },
};

function Ocean() {
  const meshRef = useRef<THREE.Mesh>(null);

  // Flat shading over a perfectly regular lattice draws a visible grid. The
  // vertices are jittered once so the facets are irregular, like hand-cut
  // tiles; the border ring stays put so the plane still covers the view.
  const geometry = useMemo(() => {
    const geo = new THREE.PlaneGeometry(150, 150, 52, 52);
    const pos = geo.attributes.position;
    const rnd = mulberry32(4242);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      if (Math.abs(x) < 70 && Math.abs(y) < 70) {
        pos.setX(i, x + (rnd() - 0.5) * 2.6);
        pos.setY(i, y + (rnd() - 0.5) * 2.6);
      }
    }
    geo.computeVertexNormals();
    return geo;
  }, []);

  useFrame(({ clock }) => {
    WATER_UNIFORMS.uTime.value = clock.elapsedTime;
    if (!meshRef.current) return;
    const geo = meshRef.current.geometry as THREE.PlaneGeometry;
    const pos = geo.attributes.position;
    const t = clock.elapsedTime;

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      // The plane is rotated -90° on X, so local Z is world height.
      pos.setZ(
        i,
        Math.sin(x * 0.3 + t * 0.6) * 0.24 + Math.cos(y * 0.25 + t * 0.4) * 0.16,
      );
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  });

  return (
    <mesh
      ref={meshRef}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, WATER_Y, 0]}
      receiveShadow
    >
      {/* Fewer, larger facets: at this camera the 96² version read as a flat
          sheet, and visible facets are how a toon sea shows its waves. */}
      <primitive object={geometry} attach="geometry" />
      {/* Opaque, unlike the previous 85%-transparent version: a full-screen
          transparent surface forces depth sorting every frame, and the flat
          fill is the point. */}
      <meshToonMaterial
        color={WATER}
        gradientMap={TOON_RAMP}
        flatShading
        side={THREE.DoubleSide}
        onBeforeCompile={(shader) => {
          // Foam crests, drawn where the surface is actually high. The vertex
          // displacement above uses the same two waves, so the lines ride the
          // real peaks instead of drifting across the surface at random.
          shader.uniforms.uTime = WATER_UNIFORMS.uTime;
          shader.uniforms.uFoam = WATER_UNIFORMS.uFoam;

          shader.vertexShader = `varying vec3 vWorldPos;\n${shader.vertexShader}`.replace(
            "#include <begin_vertex>",
            `#include <begin_vertex>
             vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
          );

          shader.fragmentShader = `uniform float uTime;\nuniform vec3 uFoam;\nvarying vec3 vWorldPos;\n${shader.fragmentShader}`.replace(
            "#include <dithering_fragment>",
            `#include <dithering_fragment>
             // Waves drawn as thin lines, the way a hand would ink them:
             // a line appears where a wave train crosses zero, so the width is
             // set by the smoothstep rather than by how much of the surface
             // happens to be crest. Thresholding the wave *height* instead
             // produced broad white blobs.
             vec2 p = vWorldPos.xz;
             // Warp the domain before drawing the crests. Without this the
             // waves are two straight sine families crossing at a constant
             // spacing, which reads as a wireframe grid rather than as swell.
             vec2 warp = vec2(
               sin(p.y * 0.13 + uTime * 0.25) + 0.5 * sin(p.y * 0.31 - uTime * 0.40),
               cos(p.x * 0.11 - uTime * 0.22) + 0.5 * cos(p.x * 0.27 + uTime * 0.35)
             );
             p += warp * 3.1;

             // Crests as contours of a slow wave field: the lines close and
             // bend instead of running straight to the horizon.
             float field = sin(p.x * 0.52 + uTime * 0.70) * 0.5
                         + sin(p.y * 0.44 - uTime * 0.52) * 0.5;
             float crest = 1.0 - smoothstep(0.0, 0.30, abs(field - 0.42));

             // Break the crests into dashes so they read as foam, not as lines
             // drawn with a ruler.
             float dash = smoothstep(0.05, 0.55, sin(p.x * 0.9 + p.y * 0.7 + uTime * 1.1));
             crest *= mix(0.35, 1.0, dash);

             // Fade with distance so the pattern cannot alias into noise.
             float fade = 1.0 - smoothstep(30.0, 68.0, length(vWorldPos.xz));
             gl_FragColor.rgb = mix(gl_FragColor.rgb, uFoam, crest * fade * 0.85);`,
          );
        }}
      />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Coconut palm
// ---------------------------------------------------------------------------

/** One frond, grown from its base so it can be rotated about the crown. */
const FROND_GEOMETRY = (() => {
  const g = new THREE.ConeGeometry(0.19, 1.05, 4, 1, false);
  g.translate(0, 0.525, 0);
  return g;
})();

function CoconutPalm({
  position,
  scale = 1,
  seed = 1,
}: {
  position: [number, number, number];
  scale?: number;
  seed?: number;
}) {
  const { trunk, crown, fronds, coconuts } = useMemo(() => {
    const rnd = mulberry32(seed * 7919 + 13);
    const height = 1.75 + rnd() * 1.0;
    const lean = (rnd() - 0.5) * 0.9;

    // A curved trunk: one tube along a spline reads far more like a palm than
    // a stack of cylinders, and stays a single outlined mesh.
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(lean * 0.12, height * 0.4, 0),
      new THREE.Vector3(lean * 0.38, height * 0.78, 0),
      new THREE.Vector3(lean * 0.62, height, 0),
    ]);
    // Thick enough to read at this camera distance; at 0.062 the trunks
    // vanished behind their own canopies.
    const trunkGeometry = new THREE.TubeGeometry(curve, 8, 0.105, 6, false);
    const crownAt = curve.getPoint(1);

    const count = 6 + Math.floor(rnd() * 3);
    const fronds = Array.from({ length: count }, (_, i) => ({
      yaw: (i / count) * Math.PI * 2 + rnd() * 0.5,
      tilt: 1.95 + rnd() * 0.5,
      scale: 0.85 + rnd() * 0.3,
    }));

    const coconuts = Array.from({ length: 3 }, (_, i) => {
      const a = (i / 3) * Math.PI * 2 + rnd() * 0.6;
      return {
        x: Math.cos(a) * 0.24,
        y: -0.3 - rnd() * 0.08,
        z: Math.sin(a) * 0.24,
      };
    });

    return { trunk: trunkGeometry, crown: crownAt, fronds, coconuts };
  }, [seed]);

  return (
    <group position={position} scale={scale}>
      <mesh geometry={trunk} castShadow>
        <meshToonMaterial
          color={TRUNK}
          gradientMap={TOON_RAMP}
          flatShading
        />
        <InkOutline />
      </mesh>

      <group position={[crown.x, crown.y, crown.z]}>
        {fronds.map((frond, i) => (
          <group key={`frond-${i}`} rotation={[0, frond.yaw, 0]}>
            <mesh
              geometry={FROND_GEOMETRY}
              rotation={[frond.tilt, 0, 0]}
              scale={[1, frond.scale, 0.42]}
              castShadow
            >
              <meshToonMaterial
                color={i % 2 === 0 ? FOLIAGE : FOLIAGE_LIGHT}
                gradientMap={TOON_RAMP}
                flatShading
              />
              <InkOutline />
            </mesh>
          </group>
        ))}

        {coconuts.map((c, i) => (
          <mesh key={`nut-${i}`} position={[c.x, c.y, c.z]} castShadow>
            <sphereGeometry args={[0.145, 7, 6]} />
            <meshToonMaterial
              color={COCONUT}
              gradientMap={TOON_RAMP}
              flatShading
            />
            <InkOutline />
          </mesh>
        ))}
      </group>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Scatter: rocks and low bushes
// ---------------------------------------------------------------------------

function Rock({
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
      <dodecahedronGeometry args={[0.22, 0]} />
      <meshToonMaterial color={color} gradientMap={TOON_RAMP} flatShading />
      <InkOutline />
    </mesh>
  );
}

function Bush({
  position,
  scale = 1,
}: {
  position: [number, number, number];
  scale?: number;
}) {
  return (
    <mesh
      position={position}
      scale={[scale, scale * 0.7, scale]}
      castShadow
    >
      <icosahedronGeometry args={[0.22, 0]} />
      <meshToonMaterial
        color={FOLIAGE}
        gradientMap={TOON_RAMP}
        flatShading
      />
      <InkOutline />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Island – one generated landform plus its scatter
// ---------------------------------------------------------------------------

interface IslandConfig {
  x: number;
  z: number;
  radius: number;
  topY: number;
  seed: number;
  segments?: number;
  palms?: number;
  rocks?: number;
  bushes?: number;
}

function Island({ config }: { config: IslandConfig }) {
  const {
    x,
    z,
    radius,
    topY,
    seed,
    segments = 11,
    palms = 0,
    rocks = 0,
    bushes = 0,
  } = config;

  const geometry = useMemo(
    () => buildIsland(radius, topY, seed, segments),
    [radius, topY, seed, segments],
  );

  // Scatter, kept clear of the avatar ring in the middle of the main island.
  const scatter = useMemo(() => {
    const rnd = mulberry32(seed * 104729 + 7);
    const place = (minFrac: number) => {
      const angle = rnd() * Math.PI * 2;
      const rr =
        radius *
        minFrac *
        shoreFactor(geometry.shoreline, angle) *
        (0.75 + rnd() * 0.25);
      return [Math.cos(angle) * rr, topY, Math.sin(angle) * rr] as [
        number,
        number,
        number,
      ];
    };

    return {
      palms: Array.from({ length: palms }, (_, i) => ({
        position: place(0.42),
        scale: 1.0 + rnd() * 0.45,
        seed: seed + i * 31,
      })),
      rocks: Array.from({ length: rocks }, () => ({
        position: place(0.55),
        scale: 0.7 + rnd() * 0.8,
      })),
      bushes: Array.from({ length: bushes }, () => ({
        position: place(0.6),
        scale: 0.7 + rnd() * 0.5,
      })),
    };
  }, [geometry.shoreline, palms, radius, rocks, bushes, seed, topY]);

  return (
    <group position={[x, 0, z]}>
      <mesh geometry={geometry.body} castShadow receiveShadow>
        <meshToonMaterial color={SAND_MID} gradientMap={TOON_RAMP} />
        <InkOutline />
      </mesh>

      <mesh geometry={geometry.cap} castShadow receiveShadow>
        <meshToonMaterial color={SAND} gradientMap={TOON_RAMP} />
        <InkOutline />
      </mesh>

      {/* Waterline foam, so the sand visibly meets the sea. Kept soft: at full
          cream opacity the ring reads as a sticker outline and the island
          looks cut out of the water. */}
      <mesh geometry={geometry.foam}>
        <meshBasicMaterial
          color="#eafaf4"
          transparent
          opacity={0.72}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>

      {scatter.palms.map((palm, i) => (
        <CoconutPalm
          key={`palm-${i}`}
          position={palm.position}
          scale={palm.scale}
          seed={palm.seed}
        />
      ))}

      {scatter.rocks.map((rock, i) => (
        <Rock key={`rock-${i}`} position={rock.position} scale={rock.scale} />
      ))}

      {scatter.bushes.map((bush, i) => (
        <Bush key={`bush-${i}`} position={bush.position} scale={bush.scale} />
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
// Avatar
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

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    const bounce = Math.sin(clock.elapsedTime * 2 + position[0]) * 0.08;
    groupRef.current.position.y = position[1] + bounce + (hovered ? 0.12 : 0);
  });

  return (
    <group ref={groupRef} position={position}>
      <AvailabilityRing available={isLocal ? true : available} />

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
        <sphereGeometry args={[0.32, 14, 14]} />
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
        position={[0, 0.66, 0]}
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
// Sea spray
// ---------------------------------------------------------------------------

const SPRAY = Array.from({ length: 40 }, () => ({
  x: (Math.random() - 0.5) * 44,
  y: Math.random() * 4 + 0.4,
  z: (Math.random() - 0.5) * 44,
  speed: 0.3 + Math.random() * 0.5,
  phase: Math.random() * Math.PI * 2,
}));

function Spray({ count = 40 }: { count?: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const data = useMemo(() => SPRAY.slice(0, count), [count]);

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.elapsedTime;
    data.forEach((p, i) => {
      dummy.position.set(
        p.x + Math.sin(t * p.speed + p.phase) * 0.4,
        p.y + Math.sin(t * p.speed * 1.3 + p.phase) * 0.5,
        p.z + Math.cos(t * p.speed + p.phase) * 0.4,
      );
      dummy.scale.setScalar(0.03 + Math.sin(t * 2 + p.phase) * 0.015);
      dummy.updateMatrix();
      ref.current!.setMatrixAt(i, dummy.matrix);
    });
    ref.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]}>
      <sphereGeometry args={[1, 6, 6]} />
      <meshBasicMaterial color={CREAM} transparent opacity={0.7} />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// The archipelago
// ---------------------------------------------------------------------------
//
// Generated rather than hand-listed: one large island with a seeded ring of
// smaller ones around it, so no two reloads lay out identical shapes.

const MAIN_ISLAND: IslandConfig = {
  x: 0,
  z: 0,
  radius: 6.4,
  topY: WATER_Y + 1.85,
  seed: 1011,
  segments: 18,
  palms: 6,
  rocks: 3,
  bushes: 5,
};

const ISLANDS: IslandConfig[] = (() => {
  const rnd = mulberry32(20261107);
  const list: IslandConfig[] = [];

  for (let i = 0; i < 11; i++) {
    const angle = (i / 11) * Math.PI * 2 + rnd() * 0.55;
    const distance = 10 + rnd() * 7;
    const radius = 1.3 + rnd() * 1.8;
    list.push({
      x: Math.cos(angle) * distance,
      z: Math.sin(angle) * distance,
      radius,
      topY: WATER_Y + 0.75 + rnd() * 0.6,
      seed: 2000 + i * 137,
      segments: 12 + Math.floor(rnd() * 5),
      palms: rnd() > 0.4 ? 1 + Math.floor(rnd() * 2) : 0,
      rocks: Math.floor(rnd() * 2),
      bushes: Math.floor(rnd() * 3),
    });
  }

  return list;
})();

// ---------------------------------------------------------------------------
// Main scene component
// ---------------------------------------------------------------------------

interface IslandWorldProps {
  users: User[];
  myId: string;
  myPosition: [number, number, number];
  myColor: string;
  onAvatarClick: (userId: string) => void;
}

export function IslandWorld({
  users,
  myId,
  myPosition,
  myColor,
  onAvatarClick,
}: IslandWorldProps) {
  const surfaceY = MAIN_ISLAND.topY + 0.42;

  const remoteUsers = users.filter((u) => u.id !== myId);
  const remoteAvatarPositions = useMemo(() => {
    return remoteUsers.map((_, index) => {
      const perRing = 8;
      const ring = Math.floor(index / perRing);
      const indexInRing = index % perRing;
      const angle = (indexInRing / perRing) * Math.PI * 2 + ring * 0.35;
      const radius = 1.9 + ring * 0.9;

      return [
        MAIN_ISLAND.x + Math.cos(angle) * radius,
        surfaceY,
        MAIN_ISLAND.z + Math.sin(angle) * radius,
      ] as [number, number, number];
    });
  }, [remoteUsers, surfaceY]);

  const localAvatarPosition: [number, number, number] = [
    MAIN_ISLAND.x,
    surfaceY,
    MAIN_ISLAND.z,
  ];

  void myPosition;

  return (
    <div className="w-full h-screen">
      <Canvas
        shadows="percentage"
        camera={{ position: [13, 11, 13], fov: 55 }}
        style={{
          // Cream paper instead of a sky gradient: the scene sits on the same
          // surface as the UI rather than floating in a different one.
          background: `linear-gradient(to bottom, ${CREAM} 0%, #f6ead6 100%)`,
        }}
      >
        {/* ---- Lighting ---- */}
        {/* Flat on purpose: toon bands need even fill, and a hot key light
            reproduces the smooth gradient this art direction removes. */}
        <ambientLight intensity={0.78} />
        <directionalLight
          position={[15, 20, 10]}
          intensity={0.95}
          castShadow
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
          shadow-camera-left={-26}
          shadow-camera-right={26}
          shadow-camera-top={26}
          shadow-camera-bottom={-26}
          shadow-camera-near={0.5}
          shadow-camera-far={70}
        />

        {/* ---- Fog, in the page colour so distance fades into the document ---- */}
        <fog attach="fog" args={[CREAM, 30, 80]} />

        <OrbitControls
          enablePan
          enableZoom
          enableRotate
          minDistance={7}
          maxDistance={34}
          maxPolarAngle={Math.PI / 2.1}
          target={[0, 0, 0]}
        />

        <Ocean />

        <Island config={MAIN_ISLAND} />
        {ISLANDS.map((island) => (
          <Island key={`island-${island.seed}`} config={island} />
        ))}

        <Avatar
          position={localAvatarPosition}
          color={myColor}
          id={myId}
          isLocal
          available
        />

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

        <Spray count={40} />
      </Canvas>
    </div>
  );
}
