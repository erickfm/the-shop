import { useEffect, useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
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
        gltf.scene.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const m = child as THREE.Mesh;
            const mats = Array.isArray(m.material) ? m.material : [m.material];
            for (const mat of mats) {
              const std = mat as THREE.MeshStandardMaterial;
              std.metalness = 0.05;
              std.roughness = 0.55;
              std.side = THREE.DoubleSide;
              if (std.map) std.map.colorSpace = THREE.SRGBColorSpace;
            }
          }
        });
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

  // Compute bbox center (orbit target) and a camera distance that fits the
  // model in view. No Bounds — Bounds was overwriting the target back to its
  // own choice, fighting our explicit one.
  const cam = useMemo(() => {
    if (!parsed) return null;
    const bbox = new THREE.Box3().setFromObject(parsed.scene);
    const center = new THREE.Vector3();
    bbox.getCenter(center);
    const size = new THREE.Vector3();
    bbox.getSize(size);
    // Fit distance for fov=32deg: half-size * 1/tan(fov/2) * margin.
    const margin = 1.4;
    const halfMax = Math.max(size.x, size.y) / 2;
    const dist = (halfMax / Math.tan((32 * Math.PI) / 180 / 2)) * margin;
    return {
      target: [center.x, center.y, center.z] as [number, number, number],
      position: [center.x, center.y, center.z + dist] as [number, number, number],
    };
  }, [parsed]);

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
  if (!parsed || !cam) {
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

  return (
    <div
      className={isFill ? "" : "rounded border border-border bg-bg overflow-hidden"}
      style={style}
    >
      <Canvas
        dpr={[1, 2]}
        camera={{ position: cam.position, fov: 32 }}
        gl={{ preserveDrawingBuffer: false, antialias: true }}
      >
        <ambientLight intensity={0.55} />
        <directionalLight position={[3, 5, 4]} intensity={1.1} />
        <directionalLight position={[-3, -2, -3]} intensity={0.4} color="#9bb3ff" />
        <primitive object={parsed.scene} />
        <OrbitControls
          target={cam.target}
          autoRotate={autoRotate}
          autoRotateSpeed={1.2}
          enableZoom={false}
          enablePan={false}
        />
      </Canvas>
    </div>
  );
}
