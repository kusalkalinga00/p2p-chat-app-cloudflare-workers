import { useRef, useMemo, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Text } from "@react-three/drei";
// @ts-ignore – three ships JS-only; types resolved via @react-three/fiber
import * as THREE from "three";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface User {
  id: string;
  x: number;
  y: number;
  z: number;
  color: string;
  available: boolean;
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

  // Pre-compute per-vertex phase offsets so waves look organic
  const phases = useMemo(() => {
    const count = 80 * 80; // segments + 1 vertices per axis → positions / 3
    const arr = new Float32Array(count);
    for (let i = 0; i < count; i++) arr[i] = Math.random() * Math.PI * 2;
    return arr;
  }, []);

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
        Math.sin(x * 0.3 + t * 0.6 + phases[i % phases.length]) * 0.15 +
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
      <meshStandardMaterial
        color="#3AAFA9"
        flatShading
        transparent
        opacity={0.85}
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
        <meshStandardMaterial color="#8B6F47" flatShading />
      </mesh>
      {/* Canopy – stacked low-poly cones */}
      <mesh position={[0, 0.85, 0]} castShadow>
        <coneGeometry args={[0.45, 0.7, 6]} />
        <meshStandardMaterial color="#2D6A4F" flatShading />
      </mesh>
      <mesh position={[0, 1.2, 0]} castShadow>
        <coneGeometry args={[0.32, 0.55, 6]} />
        <meshStandardMaterial color="#40916C" flatShading />
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
  color = "#9CA3AF",
}: {
  position: [number, number, number];
  scale?: number;
  color?: string;
}) {
  return (
    <mesh position={position} scale={scale} castShadow>
      <dodecahedronGeometry args={[0.25, 0]} />
      <meshStandardMaterial color={color} flatShading />
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
        <meshStandardMaterial color={color} flatShading />
      </mesh>

      {/* Grass/top layer — slightly wider disc on top */}
      <mesh position={[0, height / 2 + 0.02, 0]} receiveShadow>
        <cylinderGeometry
          args={[radiusTop * 1.02, radiusTop, 0.08, segments]}
        />
        <meshStandardMaterial color={color} flatShading />
      </mesh>

      {/* Bottom underside — darker layer for depth */}
      <mesh position={[0, -height / 2 - 0.15, 0]}>
        <cylinderGeometry
          args={[radiusBottom, radiusBottom * 0.6, 0.3, segments]}
        />
        <meshStandardMaterial color="#6B7280" flatShading />
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
// Availability ring – pulsing ring around available avatars
// ---------------------------------------------------------------------------

function AvailabilityRing({ available }: { available: boolean }) {
  const ringRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    if (!ringRef.current) return;
    // Pulsing scale for available users
    const pulse = available ? 1 + Math.sin(clock.elapsedTime * 3) * 0.12 : 1;
    ringRef.current.scale.set(pulse, pulse, 1);
    (ringRef.current.material as THREE.MeshBasicMaterial).opacity = available
      ? 0.5 + Math.sin(clock.elapsedTime * 3) * 0.15
      : 0.2;
  });

  return (
    <mesh
      ref={ringRef}
      position={[0, -0.45, 0]}
      rotation={[-Math.PI / 2, 0, 0]}
    >
      <ringGeometry args={[0.55, 0.7, 24]} />
      <meshBasicMaterial
        color={available ? "#10B981" : "#6B7280"}
        transparent
        opacity={0.4}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Avatar – user sphere with label, glow, idle bounce, and click handling
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

  // Idle bounce animation
  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    groupRef.current.position.y =
      position[1] + Math.sin(clock.elapsedTime * 2 + position[0]) * 0.1;
  });

  return (
    <group ref={groupRef} position={position}>
      {/* Availability / selection ring */}
      <AvailabilityRing available={isLocal ? true : available} />

      {/* Local user glow ring on the ground */}
      {isLocal && (
        <mesh position={[0, -0.44, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.72, 1.0, 24]} />
          <meshBasicMaterial
            color="#3B82F6"
            transparent
            opacity={0.25}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* Avatar sphere */}
      <mesh
        castShadow
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
        <sphereGeometry args={[0.5, 16, 16]} />
        <meshStandardMaterial
          color={color}
          emissive={isLocal ? "#3B82F6" : hovered ? color : "#000000"}
          emissiveIntensity={isLocal ? 0.35 : hovered ? 0.2 : 0}
          flatShading
        />
      </mesh>

      {/* Floating name label */}
      <Text
        position={[0, 0.9, 0]}
        fontSize={0.28}
        color={isLocal ? "#3B82F6" : "#1F2937"}
        anchorX="center"
        anchorY="bottom"
        outlineWidth={0.02}
        outlineColor="#ffffff"
      >
        {isLocal ? "You" : id.slice(0, 6)}
      </Text>

      {/* Availability status dot */}
      <mesh position={[0, 1.25, 0]}>
        <sphereGeometry args={[0.08, 8, 8]} />
        <meshStandardMaterial
          color={available || isLocal ? "#10B981" : "#EF4444"}
          emissive={available || isLocal ? "#10B981" : "#EF4444"}
          emissiveIntensity={0.4}
        />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Ambient floating particles (firefly-like)
// ---------------------------------------------------------------------------

function Particles({ count = 60 }: { count?: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  // Pre-compute random positions and phase offsets
  const data = useMemo(() => {
    const arr = [];
    for (let i = 0; i < count; i++) {
      arr.push({
        x: (Math.random() - 0.5) * 40,
        y: Math.random() * 8 + 1,
        z: (Math.random() - 0.5) * 40,
        speed: 0.3 + Math.random() * 0.5,
        phase: Math.random() * Math.PI * 2,
      });
    }
    return arr;
  }, [count]);

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
      <meshBasicMaterial color="#ffffff" transparent opacity={0.6} />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// Island presets – positions, decorations, and visual variety
// ---------------------------------------------------------------------------

const ISLANDS: IslandConfig[] = [
  {
    // Center island – largest, teal
    position: [0, -1.5, 0],
    color: "#2DD4BF",
    radiusTop: 4,
    radiusBottom: 3.2,
    height: 1.2,
    segments: 8,
    bobSpeed: 0.35,
    trees: [
      [-1.5, 1, -0.8],
      [1.2, 0.8, 1],
      [0.3, 1.2, -1.5],
    ],
    rocks: [
      { pos: [2, 0, -1.2], scale: 1 },
      { pos: [-2.2, 0, 0.8], scale: 0.7, color: "#78716C" },
    ],
  },
  {
    // Purple island – north-east
    position: [9, -1, -6],
    color: "#A78BFA",
    radiusTop: 2.8,
    radiusBottom: 2.2,
    height: 0.9,
    segments: 6,
    bobSpeed: 0.45,
    trees: [
      [0.6, 0.9, -0.4],
      [-0.8, 0.7, 0.5],
    ],
    rocks: [{ pos: [1.5, 0, 0.6], scale: 0.8, color: "#7C3AED" }],
  },
  {
    // Amber island – south-west
    position: [-8, -1.2, 5],
    color: "#FBBF24",
    radiusTop: 3.2,
    radiusBottom: 2.6,
    height: 1,
    segments: 7,
    bobSpeed: 0.55,
    trees: [[0, 1.1, 0]],
    rocks: [
      { pos: [-1.8, 0, -0.5], scale: 1.1 },
      { pos: [1.3, 0, 1], scale: 0.6, color: "#D97706" },
    ],
  },
  {
    // Coral island – south-east
    position: [6, -0.8, 7],
    color: "#FB7185",
    radiusTop: 2.4,
    radiusBottom: 1.8,
    height: 0.8,
    segments: 6,
    bobSpeed: 0.5,
    trees: [[-0.5, 0.75, 0.3]],
    rocks: [{ pos: [1, 0, -0.4], scale: 0.7, color: "#E11D48" }],
  },
  {
    // Mint island – north-west
    position: [-7, -0.9, -7],
    color: "#6EE7B7",
    radiusTop: 2.6,
    radiusBottom: 2,
    height: 0.85,
    segments: 7,
    bobSpeed: 0.4,
    trees: [
      [0.8, 0.85, -0.3],
      [-0.5, 1, 0.6],
    ],
    rocks: [],
  },
  {
    // Small blue stepping stone
    position: [3, -1.6, -3],
    color: "#7DD3FC",
    radiusTop: 1.6,
    radiusBottom: 1.2,
    height: 0.6,
    segments: 6,
    bobSpeed: 0.6,
    trees: [],
    rocks: [{ pos: [0.5, 0, 0.2], scale: 0.5, color: "#0EA5E9" }],
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
  return (
    <div className="w-full h-screen">
      <Canvas
        shadows
        camera={{ position: [12, 10, 12], fov: 55 }}
        style={{
          background: "linear-gradient(to bottom, #7DD3FC, #E0F2FE, #ffffff)",
        }}
      >
        {/* ---- Lighting ---- */}
        <ambientLight intensity={0.5} />
        <directionalLight
          position={[15, 20, 10]}
          intensity={1.2}
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
        {/* Soft fill light from below to lighten shadows */}
        <hemisphereLight args={["#BAE6FD", "#D1FAE5", 0.35]} />

        {/* ---- Fog for depth / horizon blend ---- */}
        <fog attach="fog" args={["#BAE6FD", 20, 65]} />

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
          position={myPosition}
          color={myColor}
          id={myId}
          isLocal
          available
        />

        {/* ---- Remote user avatars ---- */}
        {users
          .filter((u) => u.id !== myId)
          .map((user) => (
            <Avatar
              key={user.id}
              position={[user.x, user.y, user.z]}
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
