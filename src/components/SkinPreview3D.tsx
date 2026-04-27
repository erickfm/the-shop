import { useEffect, useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Bounds, OrbitControls } from "@react-three/drei";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import * as THREE from "three";
import { ipc, type SkinPreviewBundle } from "../lib/ipc";

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export function SkinPreview3D({
  skinFileId,
  size = 96,
  autoRotate = true,
}: {
  skinFileId: number;
  size?: number | string;
  autoRotate?: boolean;
}) {
  const [bundle, setBundle] = useState<SkinPreviewBundle | null>(null);
  const [parsed, setParsed] = useState<{ scene: THREE.Group } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setBundle(null);
    setParsed(null);
    setError(null);
    ipc
      .getSkinPreview(skinFileId)
      .then((b) => {
        if (alive) setBundle(b);
      })
      .catch((e) => {
        if (alive) setError(String(e?.message ?? e));
      });
    return () => {
      alive = false;
    };
  }, [skinFileId]);

  useEffect(() => {
    if (!bundle) return;
    let cancelled = false;
    const ab = base64ToArrayBuffer(bundle.glb);
    const loader = new GLTFLoader();
    loader.parse(
      ab,
      "",
      (gltf) => {
        if (cancelled) return;
        setParsed({ scene: gltf.scene });
      },
      (err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(`glTF parse: ${msg}`);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [bundle]);

  // Dispose textures + geometry when the parsed tree changes
  useEffect(() => {
    if (!parsed) return;
    return () => {
      parsed.scene.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const m = child as THREE.Mesh;
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          for (const mat of mats) {
            const std = mat as THREE.MeshStandardMaterial;
            std.map?.dispose();
            mat.dispose?.();
          }
          (m.geometry as THREE.BufferGeometry).dispose?.();
        }
      });
    };
  }, [parsed]);

  const [debugMode, setDebugMode] = useState<
    "textured" | "no-tex" | "checker" | "merged"
  >("textured");

  // Capture the original baseColor textures and colors ONCE per parsed scene,
  // before any debug mode mutates them. This lets us cycle modes without
  // permanently destroying the texture pointers.
  const originals = useMemo(() => {
    if (!parsed) return null;
    const map = new WeakMap<
      THREE.Material,
      { map: THREE.Texture | null; color: THREE.Color }
    >();
    parsed.scene.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const m = child as THREE.Mesh;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) {
          const std = mat as THREE.MeshStandardMaterial;
          if (!map.has(std)) {
            map.set(std, { map: std.map ?? null, color: std.color.clone() });
          }
          std.metalness = 0.05;
          std.roughness = 0.55;
          std.side = THREE.DoubleSide;
          if (std.map) std.map.colorSpace = THREE.SRGBColorSpace;
        }
      }
    });
    return map;
  }, [parsed]);

  const tunedScene = useMemo(() => {
    if (!parsed || !originals) return null;

    if (debugMode === "merged") {
      const geoms: THREE.BufferGeometry[] = [];
      parsed.scene.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const g = (child as THREE.Mesh).geometry as THREE.BufferGeometry;
          const clone = new THREE.BufferGeometry();
          const pos = g.getAttribute("position");
          const nrm = g.getAttribute("normal");
          if (pos) clone.setAttribute("position", pos);
          if (nrm) clone.setAttribute("normal", nrm);
          if (g.index) clone.setIndex(g.index);
          geoms.push(clone);
        }
      });
      const merged = BufferGeometryUtils.mergeGeometries(geoms, false);
      const mergedMesh = new THREE.Mesh(
        merged,
        new THREE.MeshStandardMaterial({
          color: 0xcfd6e6,
          metalness: 0.05,
          roughness: 0.55,
          side: THREE.DoubleSide,
        }),
      );
      const mergedGroup = new THREE.Group();
      mergedGroup.add(mergedMesh);
      return mergedGroup;
    }

    let checkerTex: THREE.Texture | null = null;
    if (debugMode === "checker") {
      const c = document.createElement("canvas");
      c.width = c.height = 64;
      const g = c.getContext("2d")!;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          g.fillStyle = (x + y) % 2 === 0 ? "#ffffff" : "#222222";
          g.fillRect(x * 8, y * 8, 8, 8);
        }
      }
      checkerTex = new THREE.CanvasTexture(c);
      checkerTex.colorSpace = THREE.SRGBColorSpace;
    }
    parsed.scene.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const m = child as THREE.Mesh;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) {
          const std = mat as THREE.MeshStandardMaterial;
          const orig = originals.get(std);
          if (debugMode === "no-tex") {
            std.map = null;
            if (orig) std.color.copy(orig.color);
          } else if (debugMode === "checker") {
            std.map = checkerTex;
            std.color.set(0xffffff);
          } else {
            // textured (default): restore original
            std.map = orig?.map ?? null;
            if (orig) std.color.copy(orig.color);
          }
          std.needsUpdate = true;
        }
      }
    });
    return parsed.scene;
  }, [parsed, originals, debugMode]);

  const isFill = size === "100%" || size === "full";
  const style = isFill
    ? { width: "100%", height: "100%", position: "absolute" as const, inset: 0 }
    : { width: size, height: size };

  if (error) {
    return (
      <div
        className="rounded border border-border bg-bg flex items-center justify-center text-muted text-[10px] text-center px-1"
        style={style}
        title={error}
      >
        no preview
      </div>
    );
  }
  if (!tunedScene) {
    return (
      <div
        className={isFill ? "" : "rounded border border-border bg-bg animate-pulse"}
        style={style}
      >
        {isFill && (
          <div className="absolute inset-0 flex items-center justify-center text-muted text-xs">
            <span className="animate-pulse">rendering…</span>
          </div>
        )}
      </div>
    );
  }

  const cycleMode = () => {
    setDebugMode((m) =>
      m === "textured"
        ? "no-tex"
        : m === "no-tex"
          ? "checker"
          : m === "checker"
            ? "merged"
            : "textured",
    );
  };

  return (
    <div
      className={
        isFill
          ? ""
          : "rounded border border-border bg-bg overflow-hidden relative"
      }
      style={style}
    >
      <Canvas
        dpr={[1, 2]}
        camera={{ position: [0, 0, 8], fov: 32 }}
        gl={{ preserveDrawingBuffer: false, antialias: true }}
      >
        <ambientLight intensity={0.55} />
        <directionalLight position={[3, 5, 4]} intensity={1.1} />
        <directionalLight position={[-3, -2, -3]} intensity={0.4} color="#9bb3ff" />
        <Bounds fit clip margin={1.15}>
          <primitive object={tunedScene} />
        </Bounds>
        <OrbitControls
          autoRotate={autoRotate}
          autoRotateSpeed={1.2}
          enableZoom={false}
          enablePan={false}
        />
      </Canvas>
      <button
        onClick={cycleMode}
        className="absolute top-2 right-2 px-2 py-1 text-[10px] rounded bg-black/60 text-white hover:bg-black/80 z-10"
        title="cycle: textured → no-tex → checker"
      >
        {debugMode}
      </button>
    </div>
  );
}
