import { useLayoutEffect, useRef, useMemo, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
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
const CORAL = "#ff5a36";
const MUSTARD = "#ffc145";
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
/** Paving: a touch darker than the plaza stone so the streets read as roads. */
const ROAD = "#b3a390";

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

/** Overshoot easing: runs past 1 before settling, which is what sells a pop. */
function easeOutBack(x: number) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
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
    const geo = new THREE.PlaneGeometry(520, 520, 76, 76);
    const pos = geo.attributes.position;
    const rnd = mulberry32(4242);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      if (Math.abs(x) < 248 && Math.abs(y) < 248) {
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
// Sky and sun – a slow day cycle driving colour, fog and light
// ---------------------------------------------------------------------------

/** Seconds for one full day: sunrise, noon, sunset, night. */
const DAY_SECONDS = 120;

const SKY_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uBottom;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform float uGlow;
  varying vec3 vDir;

  void main() {
    vec3 dir = normalize(vDir);
    // Horizon to zenith. The lower band is what the sea meets, so it stays
    // warm at dawn and dusk while the top of the sky has already gone blue.
    vec3 col = mix(uBottom, uTop, smoothstep(-0.03, 0.55, dir.y));

    // A soft bloom around the sun, strongest when it is low.
    float d = max(dot(dir, normalize(uSunDir)), 0.0);
    col += uSunColor * pow(d, 14.0) * uGlow;

    gl_FragColor = vec4(col, 1.0);
  }
`;

/** Shared with the sky material; rewritten once per frame by <DayCycle>. */
const SKY_UNIFORMS = {
  uTop: { value: new THREE.Color(CREAM) },
  uBottom: { value: new THREE.Color("#f6ead6") },
  uSunColor: { value: new THREE.Color(MUSTARD) },
  uSunDir: { value: new THREE.Vector3(0, 0.4, 1).normalize() },
  uGlow: { value: 0.8 },
};

interface SkyKey {
  /** Sun elevation: -1 at midnight, 0 at the horizon, 1 at noon. */
  at: number;
  top: THREE.Color;
  bottom: THREE.Color;
  fog: THREE.Color;
  tint: THREE.Color;
  ambient: number;
  sun: number;
  glow: number;
}

/**
 * Four moments of the day. Everything between them is interpolated, so there
 * is no hard switch at sunrise or sunset. Night keeps a decent ambient floor:
 * it has to stay possible to see the other avatars.
 */
const SKY_KEYS: SkyKey[] = [
  {
    at: -1,
    top: new THREE.Color("#101c36"),
    bottom: new THREE.Color("#25395c"),
    fog: new THREE.Color("#25395c"),
    tint: new THREE.Color("#9db9ff"),
    ambient: 0.6,
    sun: 0.1,
    glow: 0.18,
  },
  {
    at: -0.05,
    top: new THREE.Color("#2c3f68"),
    bottom: new THREE.Color("#8a6172"),
    fog: new THREE.Color("#6a5468"),
    tint: new THREE.Color("#ffb08a"),
    ambient: 0.52,
    sun: 0.2,
    glow: 0.85,
  },
  {
    at: 0.07,
    top: new THREE.Color("#7fa9cc"),
    bottom: new THREE.Color("#ffb37d"),
    fog: new THREE.Color("#f3c6a4"),
    tint: new THREE.Color("#ff9a5a"),
    ambient: 0.56,
    sun: 0.65,
    glow: 1.35,
  },
  {
    at: 0.36,
    top: new THREE.Color("#79c4e8"),
    bottom: new THREE.Color("#ddf2ec"),
    fog: new THREE.Color("#e7f5ee"),
    tint: new THREE.Color("#fff2cf"),
    ambient: 0.7,
    sun: 0.95,
    glow: 0.7,
  },
  {
    at: 1,
    top: new THREE.Color("#68b6e4"),
    bottom: new THREE.Color("#e4f7f4"),
    fog: new THREE.Color("#eef9f4"),
    tint: new THREE.Color("#fff6de"),
    ambient: 0.74,
    sun: 1,
    glow: 0.55,
  },
];

/** Reused output of `sampleSky`, so the frame loop allocates nothing. */
const SKY_STATE = {
  top: new THREE.Color(),
  bottom: new THREE.Color(),
  fog: new THREE.Color(),
  tint: new THREE.Color(),
  ambient: 0,
  sun: 0,
  glow: 0,
};

function sampleSky(elevation: number) {
  let i = 0;
  while (i < SKY_KEYS.length - 2 && elevation > SKY_KEYS[i + 1].at) i += 1;

  const a = SKY_KEYS[i];
  const b = SKY_KEYS[i + 1];
  const span = b.at - a.at;
  const raw = span === 0 ? 0 : (elevation - a.at) / span;
  const t = THREE.MathUtils.smoothstep(raw, 0, 1);

  SKY_STATE.top.copy(a.top).lerp(b.top, t);
  SKY_STATE.bottom.copy(a.bottom).lerp(b.bottom, t);
  SKY_STATE.fog.copy(a.fog).lerp(b.fog, t);
  SKY_STATE.tint.copy(a.tint).lerp(b.tint, t);
  SKY_STATE.ambient = THREE.MathUtils.lerp(a.ambient, b.ambient, t);
  SKY_STATE.sun = THREE.MathUtils.lerp(a.sun, b.sun, t);
  SKY_STATE.glow = THREE.MathUtils.lerp(a.glow, b.glow, t);

  return SKY_STATE;
}

const SUN_DIR = new THREE.Vector3();
const WHITE = new THREE.Color("#ffffff");

/**
 * Owns the sky dome, the sun, and every light in the scene.
 *
 * The cycle starts at sunrise, so opening the app shows the sun coming up and
 * then a full day passing. Time is the clock's elapsed seconds rather than a
 * React state value: this updates every frame and must not trigger renders.
 */
function DayCycle() {
  const { scene, camera } = useThree();
  const skyRef = useRef<THREE.Mesh>(null);
  const ambientRef = useRef<THREE.AmbientLight>(null);
  const sunLightRef = useRef<THREE.DirectionalLight>(null);
  const lampRef = useRef<THREE.PointLight>(null);
  const sunGroupRef = useRef<THREE.Group>(null);
  const sunCoreRef = useRef<THREE.MeshBasicMaterial>(null);
  const sunHaloRef = useRef<THREE.MeshBasicMaterial>(null);

  useFrame(({ clock }) => {
    // 0 = sunrise, π/2 = noon, π = sunset, 3π/2 = midnight.
    const theta = (clock.elapsedTime / DAY_SECONDS) * Math.PI * 2;
    const elevation = Math.sin(theta);

    SUN_DIR.set(Math.cos(theta) * 0.86, elevation, 0.38).normalize();
    const sky = sampleSky(elevation);

    SKY_UNIFORMS.uTop.value.copy(sky.top);
    SKY_UNIFORMS.uBottom.value.copy(sky.bottom);
    SKY_UNIFORMS.uSunColor.value.copy(sky.tint);
    SKY_UNIFORMS.uSunDir.value.copy(SUN_DIR);
    SKY_UNIFORMS.uGlow.value = sky.glow;

    if (scene.fog) scene.fog.color.copy(sky.fog);
    // Foam is added after lighting in the water shader, so it has to be
    // tinted by hand or it glows white at midnight.
    WATER_UNIFORMS.uFoam.value.copy(sky.bottom).lerp(WHITE, 0.55);

    const ambient = ambientRef.current;
    if (ambient) {
      ambient.intensity = sky.ambient;
      ambient.color.copy(sky.bottom).lerp(WHITE, 0.45);
    }

    const sunLight = sunLightRef.current;
    if (sunLight) {
      sunLight.intensity = sky.sun;
      sunLight.color.copy(sky.tint);
      // Keep the key light above the horizon, so night shadows do not come
      // from underneath the island.
      sunLight.position.set(
        SUN_DIR.x * 32,
        Math.max(SUN_DIR.y, 0.12) * 36,
        SUN_DIR.z * 32,
      );
    }

    const sunGroup = sunGroupRef.current;
    if (sunGroup) {
      // Positioned relative to the camera, like a sun at infinity: the glow in
      // the sky shader is directional, so the disc has to sit on the same
      // direction or the two drift apart as the camera orbits.
      sunGroup.position.copy(camera.position).addScaledVector(SUN_DIR, 68);
      sunGroup.visible = elevation > -0.06;
      sunGroup.lookAt(camera.position);
    }

    // Keep the sky centred on the camera so the gradient's horizon does not
    // slide around as the user orbits or zooms.
    if (skyRef.current) skyRef.current.position.copy(camera.position);

    if (sunCoreRef.current) sunCoreRef.current.color.copy(sky.tint);
    if (sunHaloRef.current) {
      sunHaloRef.current.color.copy(sky.tint);
      sunHaloRef.current.opacity = THREE.MathUtils.clamp(
        0.16 + elevation * 0.3,
        0.08,
        0.4,
      );
    }

    // A warm lamp over the plaza, so night is dim rather than unusable.
    const night = THREE.MathUtils.clamp(-elevation * 2.4, 0, 1);
    if (lampRef.current) lampRef.current.intensity = night * 1.15;
  });

  return (
    <>
      <ambientLight ref={ambientRef} intensity={0.72} />

      <directionalLight
        ref={sunLightRef}
        position={[15, 20, 10]}
        intensity={0.95}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-48}
        shadow-camera-right={48}
        shadow-camera-top={48}
        shadow-camera-bottom={-48}
        shadow-camera-near={0.5}
        shadow-camera-far={120}
      />

      <fog attach="fog" args={[CREAM, 90, 220]} />

      {/* Sky dome. Back-faced and huge, with depth writes off so it always
          sits behind the scene but never fights the depth buffer. */}
      <mesh ref={skyRef} frustumCulled={false}>
        {/* Radius 400: everything the scene draws has to stay inside it, or a
            far island beyond the dome would be depth-tested away. */}
        <sphereGeometry args={[400, 32, 16]} />
        <shaderMaterial
          uniforms={SKY_UNIFORMS}
          vertexShader={SKY_VERTEX}
          fragmentShader={SKY_FRAGMENT}
          side={THREE.BackSide}
          depthWrite={false}
        />
      </mesh>

      {/* Sun: two flat discs that turn to face the camera. */}
      <group ref={sunGroupRef}>
        <mesh>
          <circleGeometry args={[7.4, 32]} />
          <meshBasicMaterial
            ref={sunHaloRef}
            color={MUSTARD}
            transparent
            opacity={0.25}
            depthWrite={false}
            fog={false}
          />
        </mesh>
        <mesh position={[0, 0, 0.4]}>
          <circleGeometry args={[3.4, 32]} />
          <meshBasicMaterial ref={sunCoreRef} color={MUSTARD} fog={false} />
        </mesh>
      </group>

      <pointLight
        ref={lampRef}
        position={[0, WATER_Y + 3.4, 0]}
        color={MUSTARD}
        intensity={0}
        distance={10}
        decay={1.6}
      />
    </>
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
// Streets – flat strips that follow the island's cap
// ---------------------------------------------------------------------------

/**
 * Builds the paved network for a town.
 *
 * The island top is a shallow dome, not a plane, so a road laid flat at one
 * height either floats at the edge or sinks in the middle. Every vertex is
 * therefore lifted to the cap height at its own position: the height function
 * mirrors the three rings `buildIsland` uses for the cap (centre, inner ring,
 * rim). A wider strip in ink underneath gives the roads the same outline as
 * every other solid in the scene.
 */
function buildRoads(
  radius: number,
  topY: number,
  shoreline: Shoreline,
  roads: RoadSpec[],
): RoadNetwork {
  const capY = (x: number, z: number) => {
    const angle = Math.atan2(z, x);
    const rim = radius * shoreFactor(shoreline, angle);
    const f = Math.min(Math.hypot(x, z) / rim, 1);
    const lift =
      f <= 0.52
        ? 0.14 - 0.08 * (f / 0.52)
        : 0.06 - 0.06 * ((f - 0.52) / 0.48);
    return topY + lift;
  };

  const keepOut: { x: number; z: number; r: number }[] = [];

  const build = (extraWidth: number, lift: number, collect: boolean) => {
    const positions: number[] = [];
    const indices: number[] = [];

    const strip = (
      points: { x: number; z: number }[],
      width: number,
      closed: boolean,
      roadLift: number,
    ) => {
      const half = width / 2;
      const start = positions.length / 3;
      const count = points.length;

      for (let i = 0; i < count; i++) {
        const point = points[i];
        const prev = closed
          ? points[(i - 1 + count) % count]
          : points[Math.max(i - 1, 0)];
        const next = closed
          ? points[(i + 1) % count]
          : points[Math.min(i + 1, count - 1)];

        let tx = next.x - prev.x;
        let tz = next.z - prev.z;
        const length = Math.hypot(tx, tz) || 1;
        tx /= length;
        tz /= length;

        // Left normal of the centreline.
        const nx = -tz;
        const nz = tx;
        const lx = point.x + nx * half;
        const lz = point.z + nz * half;
        const rx = point.x - nx * half;
        const rz = point.z - nz * half;

        positions.push(lx, capY(lx, lz) + roadLift, lz);
        positions.push(rx, capY(rx, rz) + roadLift, rz);
      }

      const quads = closed ? count : count - 1;
      for (let i = 0; i < quads; i++) {
        const a = start + i * 2;
        const b = start + ((i + 1) % count) * 2;
        // +Y winding, so the road is lit from above.
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    };

    for (const road of roads) {
      if (road.kind === "ring") {
        const points = Array.from({ length: 96 }, (_, i) => {
          const angle = (i / 96) * Math.PI * 2;
          // Fixed radius: the town is planned, not contoured.
          const r = radius * road.fraction;
          return { x: Math.cos(angle) * r, z: Math.sin(angle) * r };
        });
        strip(points, road.width + extraWidth, true, lift);
        if (collect) {
          for (const p of points) {
            keepOut.push({ x: p.x, z: p.z, r: road.width / 2 + 1 });
          }
        }
      } else {
        const steps = 16;
        const points = Array.from({ length: steps }, (_, i) => {
          const fraction = road.from + ((road.to - road.from) * i) / (steps - 1);
          const r = radius * fraction;
          return {
            x: Math.cos(road.angle) * r,
            z: Math.sin(road.angle) * r,
          };
        });
        // Spokes sit a hair above the rings so the crossing is not coplanar.
        strip(points, road.width + extraWidth, false, lift + 0.012);
        if (collect) {
          for (const p of points) {
            keepOut.push({ x: p.x, z: p.z, r: road.width / 2 + 1 });
          }
        }
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  };

  return {
    road: build(0, 0.05, true),
    border: build(0.28, 0.035, false),
    keepOut,
  };
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
  /**
   * Radius kept free of scatter, so avatars are never planted inside a palm.
   * The spawn ring sits at up to ~2.9 units, and a palm dropped there both
   * hides the player and clips through the model.
   */
  clearRadius?: number;
  /** Local x/z for a lighthouse, and a radius the scatter avoids around it. */
  lighthouseAt?: [number, number];
  /** A stone plaza in the middle, where the avatars stand. */
  plaza?: boolean;
  /** Cottages, positioned by angle around the island and distance fraction. */
  houses?: HouseSpec[];
  /** The street network, drawn on the island's cap. */
  roads?: RoadSpec[];
  /** Angle for a wooden pier reaching into the sea, if this island has one. */
  pierAt?: number;
}

interface HouseSpec {
  /** Angle around the island, in radians. */
  angle: number;
  /** Distance from the centre, as a fraction of the island radius. */
  dist: number;
  scale?: number;
  roof?: string;
  walls?: string;
  /** Extra yaw on top of the default "face the plaza". */
  yaw?: number;
}

type RoadSpec =
  | { kind: "ring"; fraction: number; width: number }
  | {
      kind: "spoke";
      angle: number;
      /** Fractions of the radius where the street starts and ends. */
      from: number;
      to: number;
      width: number;
    };

interface RoadNetwork {
  road: THREE.BufferGeometry;
  border: THREE.BufferGeometry;
  keepOut: { x: number; z: number; r: number }[];
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
    clearRadius = 0,
    lighthouseAt,
    plaza = false,
    houses = [],
    roads = [],
    pierAt,
  } = config;

  const geometry = useMemo(
    () => buildIsland(radius, topY, seed, segments),
    [radius, topY, seed, segments],
  );

  const roadNetwork = useMemo(
    () =>
      roads.length
        ? buildRoads(radius, topY, geometry.shoreline, roads)
        : null,
    [geometry.shoreline, radius, roads, topY],
  );

  // Cottages sit on fixed rings, so the town reads as planned rather than
  // following every wobble of the coast. The outermost ring is still inside
  // the narrowest point of the shoreline.
  const housePlacements = useMemo(
    () =>
      houses.map((house) => {
        const rr = radius * house.dist;
        const hx = Math.cos(house.angle) * rr;
        const hz = Math.sin(house.angle) * rr;
        return {
          ...house,
          x: hx,
          z: hz,
          // The door is on +Z: turn it toward the plaza (or, for the outer
          // row, out toward its own ring road).
          rotation: Math.atan2(-hx, -hz) + (house.yaw ?? 0),
        };
      }),
    [houses, radius],
  );

  // Scatter, kept clear of the avatar ring, the buildings, the streets, and
  // the lighthouse.
  const scatter = useMemo(() => {
    const rnd = mulberry32(seed * 104729 + 7);
    const keepOut = [
      ...housePlacements.map((house) => ({
        x: house.x,
        z: house.z,
        r: 1.5 * (house.scale ?? 1),
      })),
      ...(roadNetwork ? roadNetwork.keepOut : []),
      ...(lighthouseAt
        ? [{ x: lighthouseAt[0], z: lighthouseAt[1], r: 2.8 }]
        : []),
    ];

    const place = (minFrac: number, maxFrac = minFrac + 0.24) => {
      let x = 0;
      let z = 0;
      // Resample rather than nudge: a palm dropped on the lighthouse looks
      // worse than one fewer palm.
      for (let attempt = 0; attempt < 32; attempt++) {
        const angle = rnd() * Math.PI * 2;
        const frac = minFrac + rnd() * (maxFrac - minFrac);
        const rr = Math.max(
          clearRadius,
          radius *
            frac *
            shoreFactor(geometry.shoreline, angle) *
            (0.82 + rnd() * 0.18),
        );
        x = Math.cos(angle) * rr;
        z = Math.sin(angle) * rr;
        if (!keepOut.some((k) => Math.hypot(x - k.x, z - k.z) < k.r)) break;
      }
      return [x, topY, z] as [number, number, number];
    };

    return {
      palms: Array.from({ length: palms }, (_, i) => ({
        position: place(0.45, 0.82),
        scale: 1.0 + rnd() * 0.45,
        seed: seed + i * 31,
      })),
      rocks: Array.from({ length: rocks }, () => ({
        position: place(0.5, 0.9),
        scale: 0.7 + rnd() * 0.8,
      })),
      bushes: Array.from({ length: bushes }, () => ({
        position: place(0.4, 0.88),
        scale: 0.7 + rnd() * 0.5,
      })),
    };
  }, [
    clearRadius,
    geometry.shoreline,
    housePlacements,
    lighthouseAt,
    palms,
    radius,
    roadNetwork,
    rocks,
    bushes,
    seed,
    topY,
  ]);

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

      {/* Streets: an ink strip underneath a lighter paved strip, so the roads
          get the same outline as the rest of the scene. */}
      {roadNetwork && (
        <>
          <mesh geometry={roadNetwork.border}>
            <meshBasicMaterial color={INK} />
          </mesh>
          <mesh geometry={roadNetwork.road} receiveShadow>
            <meshToonMaterial color={ROAD} gradientMap={TOON_RAMP} />
          </mesh>
        </>
      )}

      {plaza && <Plaza y={topY + 0.16} />}

      {housePlacements.map((house, i) => (
        <House
          key={`house-${i}`}
          position={[house.x, topY + 0.03, house.z]}
          rotation={house.rotation}
          scale={house.scale ?? 1}
          roof={house.roof}
          walls={house.walls}
        />
      ))}

      {pierAt !== undefined && (
        <Pier angle={pierAt} radius={radius} shoreline={geometry.shoreline} />
      )}

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

      {lighthouseAt && (
        <Lighthouse position={[lighthouseAt[0], topY, lighthouseAt[1]]} />
      )}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Buoy – a channel marker bobbing in the swell
// ---------------------------------------------------------------------------

function Buoy({
  position,
  seed,
}: {
  position: [number, number, number];
  seed: number;
}) {
  const ref = useRef<THREE.Group>(null);
  const phase = useMemo(() => (seed % 100) / 15, [seed]);

  useFrame(({ clock }) => {
    const group = ref.current;
    if (!group) return;
    const t = clock.elapsedTime;
    // Bob on the same period as the swell and lean with it, so the markers
    // look like they are riding the water rather than hovering over it.
    group.position.y = WATER_Y + 0.16 + Math.sin(t * 1.15 + phase) * 0.11;
    group.rotation.z = Math.sin(t * 0.95 + phase) * 0.09;
    group.rotation.x = Math.cos(t * 1.05 + phase * 0.7) * 0.07;
  });

  // Tall and slim with a pointed finial: a round cap on a short body read as a
  // tiny character's head from the default camera.
  return (
    <group ref={ref} position={position} scale={1.25}>
      <mesh position={[0, 0.44, 0]} castShadow>
        <coneGeometry args={[0.15, 0.86, 9]} />
        <meshToonMaterial color={CORAL} gradientMap={TOON_RAMP} flatShading />
        <InkOutline />
      </mesh>
      <mesh position={[0, 0.5, 0]} castShadow>
        <cylinderGeometry args={[0.115, 0.13, 0.1, 9]} />
        <meshToonMaterial color={CREAM} gradientMap={TOON_RAMP} flatShading />
        <InkOutline />
      </mesh>
      <mesh position={[0, 0.95, 0]} castShadow>
        <coneGeometry args={[0.06, 0.16, 8]} />
        <meshToonMaterial
          color={MUSTARD}
          gradientMap={TOON_RAMP}
          flatShading
        />
        <InkOutline />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Boats – little hulls drifting on slow circles, bobbing with the swell
// ---------------------------------------------------------------------------

/**
 * A pointed hull, extruded from a top-view outline and laid flat. Extruding a
 * shape is the cheapest way to get a real bow and stern instead of a box; the
 * ink outline then carries the silhouette.
 */
const HULL_GEOMETRY = (() => {
  const shape = new THREE.Shape();
  shape.moveTo(-0.72, -0.3);
  shape.lineTo(0.32, -0.3);
  shape.quadraticCurveTo(0.9, 0, 0.32, 0.3);
  shape.lineTo(-0.72, 0.3);
  shape.closePath();

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.36,
    bevelEnabled: false,
    curveSegments: 4,
  });
  // The shape lies in XY and extrudes along +Z. Rotate so it lies in XZ:
  // keel at y = 0, deck at y = 0.36, bow pointing along +X.
  geometry.rotateX(-Math.PI / 2);
  return geometry;
})();

/** A right-triangle sail, normal along +Z, with its luff on the mast. */
const SAIL_GEOMETRY = (() => {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(0, 1.05);
  shape.lineTo(0.74, 0.08);
  shape.closePath();
  return new THREE.ShapeGeometry(shape);
})();

function Boat({
  radius,
  speed,
  phase,
  direction = 1,
  hull = CORAL,
  sail = CREAM,
  scale = 1,
}: {
  radius: number;
  speed: number;
  phase: number;
  direction?: 1 | -1;
  hull?: string;
  sail?: string;
  scale?: number;
}) {
  const ref = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    const group = ref.current;
    if (!group) return;
    const t = clock.elapsedTime;
    const angle = phase + t * speed * direction;

    // Orbit, bob, and lean with the swell.
    group.position.set(
      Math.cos(angle) * radius,
      WATER_Y + 0.34 + Math.sin(t * 0.9 + phase) * 0.08,
      Math.sin(angle) * radius,
    );

    // Point the bow along the tangent. The hull's bow is +X; rotating +X by θ
    // about Y gives (cos θ, 0, -sin θ), so solve for the tangent (-sin, cos).
    const tx = -Math.sin(angle) * direction;
    const tz = Math.cos(angle) * direction;
    group.rotation.y = Math.atan2(-tz, tx);
    group.rotation.z = Math.sin(t * 0.8 + phase) * 0.06;
    group.rotation.x = Math.cos(t * 1.05 + phase) * 0.04;
  });

  return (
    <group ref={ref} scale={scale}>
      <mesh geometry={HULL_GEOMETRY} castShadow>
        <meshToonMaterial color={hull} gradientMap={TOON_RAMP} flatShading />
        <InkOutline />
      </mesh>

      {/* deck */}
      <mesh position={[0.02, 0.37, 0]} castShadow>
        <boxGeometry args={[0.92, 0.05, 0.44]} />
        <meshToonMaterial color={CREAM} gradientMap={TOON_RAMP} flatShading />
      </mesh>

      {/* mast */}
      <mesh position={[0.06, 0.94, 0]} castShadow>
        <cylinderGeometry args={[0.032, 0.045, 1.15, 6]} />
        <meshToonMaterial color={TRUNK} gradientMap={TOON_RAMP} flatShading />
        <InkOutline />
      </mesh>

      {/* sail */}
      <mesh geometry={SAIL_GEOMETRY} position={[0.06, 0.48, 0]}>
        <meshToonMaterial
          color={sail}
          gradientMap={TOON_RAMP}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* pennant */}
      <mesh position={[0.06, 1.54, 0]}>
        <planeGeometry args={[0.22, 0.11]} />
        <meshBasicMaterial
          color={hull}
          side={THREE.DoubleSide}
          transparent
          opacity={0.95}
        />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Lighthouse – the one landmark on the horizon
// ---------------------------------------------------------------------------

function Lighthouse({ position }: { position: [number, number, number] }) {
  return (
    // Scaled up from the natural prop scale: at one character's height it read
    // as scenery rather than as the landmark the island is built around.
    <group position={position} scale={1.85}>
      {/* tower, in bands so it reads from a distance */}
      <mesh position={[0, 0.75, 0]} castShadow>
        <cylinderGeometry args={[0.26, 0.34, 1.5, 10]} />
        <meshToonMaterial color={CREAM} gradientMap={TOON_RAMP} flatShading />
        <InkOutline />
      </mesh>
      <mesh position={[0, 0.62, 0]} castShadow>
        <cylinderGeometry args={[0.3, 0.31, 0.26, 10]} />
        <meshToonMaterial color={CORAL} gradientMap={TOON_RAMP} flatShading />
        <InkOutline />
      </mesh>
      {/* gallery and lamp */}
      <mesh position={[0, 1.56, 0]} castShadow>
        <cylinderGeometry args={[0.34, 0.3, 0.1, 10]} />
        <meshToonMaterial color={INK} gradientMap={TOON_RAMP} flatShading />
        <InkOutline />
      </mesh>
      <mesh position={[0, 1.74, 0]} castShadow>
        <cylinderGeometry args={[0.22, 0.22, 0.28, 10]} />
        <meshToonMaterial
          color={MUSTARD}
          gradientMap={TOON_RAMP}
          flatShading
        />
        <InkOutline />
      </mesh>
      {/* roof */}
      <mesh position={[0, 1.98, 0]} castShadow>
        <coneGeometry args={[0.32, 0.3, 10]} />
        <meshToonMaterial color={CORAL} gradientMap={TOON_RAMP} flatShading />
        <InkOutline />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Village: cottages, a stone plaza, and a pier
// ---------------------------------------------------------------------------

/**
 * A cottage in the same pen-and-fill style: box walls, a four-sided pyramid
 * roof, and flat planes for the door and windows so the front reads at a
 * distance. The plinth hides the seam where the building meets the sloped
 * sand.
 */
function House({
  position,
  rotation,
  scale = 1,
  roof = CORAL,
  walls = CREAM,
}: {
  position: [number, number, number];
  rotation: number;
  scale?: number;
  roof?: string;
  walls?: string;
}) {
  return (
    <group position={position} rotation={[0, rotation, 0]} scale={scale}>
      {/* plinth */}
      <mesh position={[0, 0.05, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.62, 0.2, 1.38]} />
        <meshToonMaterial
          color={SAND_MID}
          gradientMap={TOON_RAMP}
          flatShading
        />
        <InkOutline />
      </mesh>

      {/* walls */}
      <mesh position={[0, 0.64, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.34, 1.0, 1.1]} />
        <meshToonMaterial color={walls} gradientMap={TOON_RAMP} flatShading />
        <InkOutline />
      </mesh>

      {/* Pyramid roof. A four-sided cone is a square pyramid; rotating it 45°
          puts its faces over the walls instead of its corners. */}
      <mesh position={[0, 1.42, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
        <coneGeometry args={[1.18, 0.72, 4]} />
        <meshToonMaterial color={roof} gradientMap={TOON_RAMP} flatShading />
        <InkOutline />
      </mesh>

      {/* door */}
      <mesh position={[0, 0.42, 0.556]}>
        <planeGeometry args={[0.34, 0.62]} />
        <meshToonMaterial color={TRUNK} gradientMap={TOON_RAMP} />
      </mesh>

      {/* windows: lit from inside, so the village still reads at night. Basic
          material rather than toon: these are the only emissive-looking
          surfaces in the scene. */}
      {[-0.42, 0.42].map((x) => (
        <mesh key={`window-${x}`} position={[x, 0.8, 0.556]}>
          <planeGeometry args={[0.26, 0.24]} />
          <meshBasicMaterial color={MUSTARD} />
        </mesh>
      ))}
      <mesh position={[0.676, 0.8, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[0.3, 0.26]} />
        <meshBasicMaterial color={MUSTARD} />
      </mesh>

      {/* chimney */}
      <mesh position={[0.4, 1.62, -0.22]} castShadow>
        <boxGeometry args={[0.2, 0.52, 0.2]} />
        <meshToonMaterial color={STONE} gradientMap={TOON_RAMP} flatShading />
        <InkOutline />
      </mesh>
    </group>
  );
}

/**
 * Stone plaza under the avatars. A squat cylinder rather than a flat disc, so
 * the edge has a visible lip and the slightly domed sand underneath cannot
 * poke through the middle. Sized to the island rather than to one character:
 * at 3.2 it disappeared on the enlarged landmass.
 */
function Plaza({ y }: { y: number }) {
  return (
    <mesh position={[0, y - 0.08, 0]} castShadow receiveShadow>
      <cylinderGeometry args={[9.2, 9.6, 0.16, 40]} />
      <meshToonMaterial color={STONE} gradientMap={TOON_RAMP} flatShading />
      <InkOutline />
    </mesh>
  );
}

/**
 * A jetty on the waterline: deck on posts, two crates, and a short ramp up the
 * beach. Positioned in world space so its inner end always meets the shore
 * regardless of the irregular coastline.
 */
function Pier({
  angle,
  radius,
  shoreline,
}: {
  angle: number;
  radius: number;
  shoreline: Shoreline;
}) {
  const distance = radius * 1.22 * shoreFactor(shoreline, angle);
  const x = Math.cos(angle) * distance;
  const z = Math.sin(angle) * distance;
  // Local +Z points straight out to sea.
  const yaw = Math.PI / 2 - angle;
  const deckY = WATER_Y + 0.5;

  const posts: [number, number][] = [
    [-0.52, 0.4],
    [0.52, 0.4],
    [-0.52, 2.0],
    [0.52, 2.0],
    [-0.52, 3.8],
    [0.52, 3.8],
  ];

  return (
    <group position={[x, deckY, z]} rotation={[0, yaw, 0]}>
      {/* Deck, starting at the waterline. The old beach ramp was sized for a
          much smaller island and floated above the sand at this scale. */}
      <mesh position={[0, 0, 2.1]} castShadow receiveShadow>
        <boxGeometry args={[1.3, 0.16, 4.6]} />
        <meshToonMaterial color={TRUNK} gradientMap={TOON_RAMP} flatShading />
        <InkOutline />
      </mesh>

      {/* One step down to the wet sand. */}
      <mesh position={[0, -0.2, -0.28]} castShadow>
        <boxGeometry args={[1.3, 0.14, 0.55]} />
        <meshToonMaterial color={TRUNK} gradientMap={TOON_RAMP} flatShading />
        <InkOutline />
      </mesh>

      {posts.map(([px, pz], i) => (
        <mesh key={`post-${i}`} position={[px, -0.55, pz]} castShadow>
          <cylinderGeometry args={[0.08, 0.09, 1.4, 6]} />
          <meshToonMaterial
            color={TRUNK}
            gradientMap={TOON_RAMP}
            flatShading
          />
          <InkOutline />
        </mesh>
      ))}

      {/* crates waiting to be loaded */}
      <mesh position={[0.22, 0.25, 3.0]} rotation={[0, 0.45, 0]} castShadow>
        <boxGeometry args={[0.42, 0.42, 0.42]} />
        <meshToonMaterial
          color={SAND_MID}
          gradientMap={TOON_RAMP}
          flatShading
        />
        <InkOutline />
      </mesh>
      <mesh position={[-0.28, 0.21, 2.1]} rotation={[0, 0.2, 0]} castShadow>
        <boxGeometry args={[0.34, 0.34, 0.34]} />
        <meshToonMaterial color={SAND} gradientMap={TOON_RAMP} flatShading />
        <InkOutline />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Character – capsule body, head, arms, legs, ink dot eyes
// ---------------------------------------------------------------------------
//
// A sphere marked presence and nothing else: no front, no feet, no read of who
// is facing whom. This turns to face the camera every frame, so it always has
// a face and a front, and the silhouette says "person" at this camera height.

function Character({ color }: { color: string }) {
  const ref = useRef<THREE.Group>(null);

  useFrame(({ camera }) => {
    const group = ref.current;
    const holder = group?.parent;
    if (!group || !holder) return;
    // Yaw so the +Z face (the eyes) points at the camera.
    group.rotation.y = Math.atan2(
      camera.position.x - holder.position.x,
      camera.position.z - holder.position.z,
    );
  });

  return (
    <group ref={ref}>
      {/* Contact shadow. The shadow map is spread over ~96 units, far too
          coarse to anchor something this small to the ground. */}
      <mesh
        position={[0.05, 0.012, 0.03]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <circleGeometry args={[0.34, 20]} />
        <meshBasicMaterial
          color={INK}
          transparent
          opacity={0.22}
          depthWrite={false}
        />
      </mesh>

      {/* legs */}
      {[-1, 1].map((side) => (
        <mesh
          key={`leg-${side}`}
          position={[side * 0.085, 0.13, 0]}
          castShadow
        >
          <capsuleGeometry args={[0.062, 0.14, 3, 7]} />
          <meshToonMaterial color={color} gradientMap={TOON_RAMP} flatShading />
          <InkOutline />
        </mesh>
      ))}

      {/* body */}
      <mesh position={[0, 0.44, 0]} castShadow>
        <capsuleGeometry args={[0.19, 0.3, 4, 9]} />
        <meshToonMaterial color={color} gradientMap={TOON_RAMP} flatShading />
        <InkOutline />
      </mesh>

      {/* arms */}
      {[-1, 1].map((side) => (
        <mesh
          key={`arm-${side}`}
          position={[side * 0.225, 0.47, 0]}
          rotation={[0, 0, side * 0.34]}
          castShadow
        >
          <capsuleGeometry args={[0.055, 0.18, 3, 7]} />
          <meshToonMaterial color={color} gradientMap={TOON_RAMP} flatShading />
          <InkOutline />
        </mesh>
      ))}

      {/* head */}
      <mesh position={[0, 0.9, 0]} castShadow>
        <sphereGeometry args={[0.19, 14, 12]} />
        <meshToonMaterial color={color} gradientMap={TOON_RAMP} flatShading />
        <InkOutline />
      </mesh>

      {/* eyes */}
      {[-1, 1].map((side) => (
        <mesh key={`eye-${side}`} position={[side * 0.082, 0.945, 0.172]}>
          <sphereGeometry args={[0.05, 10, 10]} />
          <meshBasicMaterial color={INK} />
        </mesh>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Availability ring – flat ink ring marking who can be invited
// ---------------------------------------------------------------------------

function AvailabilityRing({ available }: { available: boolean }) {
  return (
    <mesh position={[0, 0.015, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.36, 0.46, 28]} />
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
  isLocal = false,
  available = true,
  onClick,
}: {
  position: [number, number, number];
  color: string;
  isLocal?: boolean;
  available?: boolean;
  onClick?: () => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const bodyRef = useRef<THREE.Group>(null);
  const [hovered, setHovered] = useState(false);

  // Clock stamp of the last frame, so pointer handlers can schedule an
  // animation against the same time source the frame loop uses.
  const nowRef = useRef(0);
  const bornAt = useRef<number | null>(null);
  const pressedAt = useRef<number | null>(null);

  useFrame(({ clock }) => {
    const outer = groupRef.current;
    const body = bodyRef.current;
    if (!outer || !body) return;

    const t = clock.elapsedTime;
    nowRef.current = t;
    if (bornAt.current === null) bornAt.current = t;

    const bounce = Math.sin(t * 2 + position[0]) * 0.08;
    outer.position.y = position[1] + bounce + (hovered ? 0.12 : 0);

    // Arriving pops: scale runs slightly past 1 and settles.
    const age = t - bornAt.current;
    const pop = age < 0.45 ? easeOutBack(age / 0.45) : 1;
    const hover = hovered ? 1.07 : 1;

    // Clicking squashes: wider and shorter for a moment, like a sticker
    // being pressed into the page.
    let sx = 1;
    let sy = 1;
    if (pressedAt.current !== null) {
      const progress = (t - pressedAt.current) / 0.2;
      if (progress >= 1) {
        pressedAt.current = null;
      } else {
        const k = Math.sin(Math.PI * progress);
        sy = 1 - 0.16 * k;
        sx = 1 + 0.14 * k;
      }
    }

    const base = pop * hover;
    body.scale.set(base * sx, base * sy, base * sx);
  });

  return (
    <group ref={groupRef} position={position}>
      <AvailabilityRing available={isLocal ? true : available} />

      {/* Handlers sit on the group: R3F bubbles pointer events up from the
          child meshes, so the whole character is one click target. */}
      <group
        ref={bodyRef}
        onClick={(e) => {
          e.stopPropagation();
          pressedAt.current = nowRef.current;
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
        <Character color={color} />
      </group>

      {/* The name label is drawn by <WorldLabels> in a DOM overlay above the
          canvas. drei's <Html> was used here and proved unreliable in this
          stack: instances silently vanished from the DOM, taking labels with
          them, and React logged "attempted to synchronously unmount a root
          while React was already rendering" on every mount. */}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Name labels — a DOM overlay projected from the camera
// ---------------------------------------------------------------------------
//
// drei's <Html> created and tore down a React root per label, which in this
// stack left labels missing from the DOM entirely. These are plain elements in
// an overlay above the canvas, positioned by projecting a world point through
// the camera each frame — no portal, no extra root, nothing to unmount.

const LABEL_BASE =
  "absolute left-0 top-0 whitespace-nowrap rounded-full border-2 border-ink px-3 py-1 text-[12px] font-extrabold tracking-tight shadow-[2px_2px_0_var(--color-ink)]";

/**
 * Live label elements, keyed by user id.
 *
 * The spans are rendered by React in the overlay; this map is how the
 * in-canvas projection loop finds them to position. Sharing DOM nodes beats
 * creating them from inside the canvas: R3F mounts its children in a separate
 * root, so anything created there races the overlay's own mount and can end up
 * attaching to nothing.
 */
const LABEL_NODES = new Map<string, HTMLSpanElement>();

interface LabelItem {
  id: string;
  label: string;
  position: [number, number, number];
  isLocal: boolean;
}

function WorldLabels({ items }: { items: LabelItem[] }) {
  const { camera } = useThree();
  const projected = useMemo(() => new THREE.Vector3(), []);

  useFrame(({ size }) => {
    const width = size.width;
    const height = size.height;

    for (const item of items) {
      const el = LABEL_NODES.get(item.id);
      if (!el) continue;

      projected
        .set(item.position[0], item.position[1] + 1.45, item.position[2])
        .project(camera);

      // Behind the camera, or far outside the viewport: hide rather than draw
      // a mirrored label at the wrong place.
      if (projected.z > 1) {
        el.style.display = "none";
        continue;
      }

      el.style.display = "";
      const x = (projected.x * 0.5 + 0.5) * width;
      const y = (-projected.y * 0.5 + 0.5) * height;

      // Shrink slightly with distance, like a diegetic tag would.
      const distance = camera.position.distanceTo(
        projected.set(item.position[0], item.position[1], item.position[2]),
      );
      const scale = THREE.MathUtils.clamp(16 / distance, 0.62, 1.15);

      // Position with left/top and centre with a single transform. Putting the
      // positional translate in the same transform list let the per-label
      // scale multiply the -50% centring, so labels at different distances were
      // offset from their characters by different amounts.
      el.style.left = `${x.toFixed(1)}px`;
      el.style.top = `${y.toFixed(1)}px`;
      el.style.transformOrigin = "50% 100%";
      el.style.transform = `translate(-50%, -100%) scale(${scale.toFixed(2)})`;
    }
  });

  return null;
}

// ---------------------------------------------------------------------------
// Sea spray
// ---------------------------------------------------------------------------

const SPRAY = Array.from({ length: 110 }, () => ({
  x: (Math.random() - 0.5) * 140,
  y: Math.random() * 4 + 0.4,
  z: (Math.random() - 0.5) * 140,
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
// One big island, and a handful of small ones far out on the horizon. The old
// near ring is gone: with the main island this wide it would have been beach.

// Streets: two ring roads, four radial connectors, and a main street out to
// the pier. All radii are fractions of the island radius, not of the local
// shoreline: the town is planned, and its outermost paving is still inside
// the narrowest part of the coast.
const TOWN_ROADS: RoadSpec[] = [
  { kind: "ring", fraction: 0.46, width: 1.8 },
  { kind: "ring", fraction: 0.725, width: 1.6 },
  { kind: "spoke", angle: Math.PI / 4, from: 0.35, to: 0.725, width: 1.6 },
  {
    kind: "spoke",
    angle: (3 * Math.PI) / 4,
    from: 0.35,
    to: 0.725,
    width: 1.6,
  },
  {
    kind: "spoke",
    angle: (5 * Math.PI) / 4,
    from: 0.35,
    to: 0.725,
    width: 1.6,
  },
  {
    kind: "spoke",
    angle: (7 * Math.PI) / 4,
    from: 0.35,
    to: 0.725,
    width: 1.6,
  },
  { kind: "spoke", angle: 0.49, from: 0.35, to: 0.92, width: 2.6 },
];

// Two rows of cottages lining the ring roads. Angles deliberately avoid the
// main street (0.49 rad), the radial connectors (45/135/225/315°), and the
// lighthouse (212°).
const TOWN_HOUSES: HouseSpec[] = (() => {
  const roofs = [CORAL, MUSTARD, TEAL];
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const angles = [15, 70, 100, 160, 190, 250, 285, 350];

  return [
    // Inner row: doors face the plaza and ring road A.
    ...angles.map((deg, i) => ({
      angle: toRad(deg),
      dist: 0.545,
      scale: 1.2 + (i % 3) * 0.075,
      roof: roofs[i % 3],
    })),
    // Outer row: doors face outward onto ring road B, backs to the alley.
    ...angles.map((deg, i) => ({
      angle: toRad(deg),
      dist: 0.64,
      scale: 1.2 + ((i + 1) % 3) * 0.075,
      roof: roofs[(i + 1) % 3],
      yaw: Math.PI,
    })),
  ];
})();

const MAIN_ISLAND: IslandConfig = {
  x: 0,
  z: 0,
  // Sized to the zoomed-out view: at maximum zoom the island should fill most
  // of the frame instead of leaving a ring of empty sea around it.
  radius: 26,
  topY: WATER_Y + 2.1,
  seed: 1011,
  // More segments keep the long coastline from reading as a polygon.
  segments: 52,
  // The plaza is ~18 units across and the scatter starts outside it.
  clearRadius: 10.6,
  plaza: true,
  // Back-left, at the very edge of the cap on that side (0.99 of the rim at
  // this angle, ~21.0), like a lighthouse on the headland.
  lighthouseAt: [-17.8, -11.1],
  // Out the front-right, away from the lighthouse.
  pierAt: 0.49,
  houses: TOWN_HOUSES,
  roads: TOWN_ROADS,
  // The town covers the middle; palms, rocks and bushes fill the remaining
  // land and the beach.
  palms: 34,
  rocks: 20,
  bushes: 28,
};

const ISLANDS: IslandConfig[] = (() => {
  const rnd = mulberry32(20261107);
  const list: IslandConfig[] = [];

  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2 + rnd() * 0.5;
    // Far out on the horizon, well beyond the boat lane and the zoom limit.
    const distance = 110 + rnd() * 40;
    const radius = 2.5 + rnd() * 2.0;
    list.push({
      x: Math.cos(angle) * distance,
      z: Math.sin(angle) * distance,
      radius,
      topY: WATER_Y + 0.8 + rnd() * 0.7,
      seed: 2000 + i * 137,
      segments: 14 + Math.floor(rnd() * 5),
      palms: 1 + Math.floor(rnd() * 2),
      rocks: Math.floor(rnd() * 2),
      bushes: Math.floor(rnd() * 3),
    });
  }

  return list;
})();

/** Channel markers, just outside the waterline all the way around. */
const BUOYS = (() => {
  const rnd = mulberry32(99173);
  const shoreline = makeShoreline(MAIN_ISLAND.seed);
  return Array.from({ length: 11 }, (_, i) => {
    const angle = (i / 11) * Math.PI * 2 + 0.95 + rnd() * 0.24;
    // The waterline sits at ~1.24× the sand rim. Following the actual
    // shoreline keeps a marker off the beach where the coast juts out.
    const rim = MAIN_ISLAND.radius * shoreFactor(shoreline, angle);
    const distance = rim * (1.29 + rnd() * 0.04);
    return {
      position: [
        Math.cos(angle) * distance,
        WATER_Y + 0.16,
        Math.sin(angle) * distance,
      ] as [number, number, number],
      seed: 500 + i * 41,
    };
  });
})();

/**
 * Boats on slow circular drifts between the main island and the horizon.
 * Different radii and speeds mean they never fall into formation; a negative
 * direction sends one the other way round.
 */
const BOATS = [
  {
    radius: 46,
    speed: 0.045,
    phase: 0.4,
    direction: 1,
    hull: CORAL,
    sail: CREAM,
    scale: 1.8,
  },
  {
    radius: 49,
    speed: 0.036,
    phase: 2.6,
    direction: -1,
    hull: TEAL,
    sail: MUSTARD,
    scale: 2.0,
  },
  {
    radius: 52,
    speed: 0.06,
    phase: 4.4,
    direction: 1,
    hull: MUSTARD,
    sail: CORAL,
    scale: 1.7,
  },
  {
    radius: 56,
    speed: 0.03,
    phase: 5.6,
    direction: -1,
    hull: CREAM,
    sail: TEAL,
    scale: 1.9,
  },
] as const;

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
  // Feet on the plaza: the character is modelled from y=0 up.
  const surfaceY = MAIN_ISLAND.topY + 0.18;

  const remoteUsers = users.filter((u) => u.id !== myId);
  const remoteAvatarPositions = useMemo(() => {
    return remoteUsers.map((_, index) => {
      // Twelve per ring, so three rings still fit on the plaza before the
      // inner ring road. The clamp keeps the fourth ring off the paving.
      const perRing = 12;
      const ring = Math.floor(index / perRing);
      const indexInRing = index % perRing;
      const angle = (indexInRing / perRing) * Math.PI * 2 + ring * 0.35;
      const radius = Math.min(6.8 + ring * 1.7, 10.4);

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

  const labelItems: LabelItem[] = [
    { id: myId, label: "You", position: localAvatarPosition, isLocal: true },
    ...remoteUsers.map((user, index) => ({
      id: user.id,
      label: user.id.slice(0, 6),
      position: remoteAvatarPositions[index],
      isLocal: false,
    })),
  ];

  void myPosition;

  return (
    <div className="relative h-screen w-full">
      <Canvas
        shadows="percentage"
        camera={{ position: [35, 28, 35], fov: 55 }}
        style={{
          // Fallback only: the sky dome covers the canvas from the first frame.
          // Kept close to the dawn horizon so there is no flash on mount.
          background: `linear-gradient(to bottom, #ffb37d 0%, #f6ead6 100%)`,
        }}
      >
        <DayCycle />

        <OrbitControls
          enablePan
          enableZoom
          enableRotate
          minDistance={30}
          maxDistance={62}
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
          isLocal
          available
        />

        {remoteUsers.map((user, index) => (
          <Avatar
            key={user.id}
            position={remoteAvatarPositions[index]}
            color={user.color}
            available={user.available}
            onClick={() => onAvatarClick(user.id)}
          />
        ))}

        {BUOYS.map((buoy) => (
          <Buoy key={buoy.seed} position={buoy.position} seed={buoy.seed} />
        ))}

        {BOATS.map((boat, i) => (
          <Boat key={`boat-${i}`} {...boat} />
        ))}

        <Spray count={110} />

        <WorldLabels items={labelItems} />
      </Canvas>

      {/* Labels live in the DOM, above the canvas. React renders them; the
          in-canvas loop above only writes their positions each frame. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {labelItems.map((item) => (
          <span
            key={item.id}
            ref={(el) => {
              if (el) LABEL_NODES.set(item.id, el);
              else LABEL_NODES.delete(item.id);
            }}
            className={`${LABEL_BASE} ${
              item.isLocal ? "bg-mustard text-ink" : "bg-cream text-ink"
            }`}
          >
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}
