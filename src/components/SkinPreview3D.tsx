import { useEffect, useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Bounds, OrbitControls } from "@react-three/drei";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import * as THREE from "three";
import { ipc } from "../lib/ipc";

export function SkinPreview3D({
  skinFileId,
  size = 96,
  autoRotate = true,
}: {
  skinFileId: number;
  size?: number | string;
  autoRotate?: boolean;
}) {
  const [objText, setObjText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setObjText(null);
    setError(null);
    ipc
      .getSkinObj(skinFileId)
      .then((txt) => {
        if (alive) setObjText(txt);
      })
      .catch((e) => {
        if (alive) setError(String(e?.message ?? e));
      });
    return () => {
      alive = false;
    };
  }, [skinFileId]);

  const obj = useMemo(() => {
    if (!objText) return null;
    try {
      const loader = new OBJLoader();
      const group = loader.parse(objText);
      group.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const m = child as THREE.Mesh;
          const geom = m.geometry as THREE.BufferGeometry;
          const hasColors = geom.getAttribute("color") != null;
          m.material = new THREE.MeshStandardMaterial({
            color: hasColors ? "#ffffff" : "#cfd6e6",
            vertexColors: hasColors,
            metalness: 0.05,
            roughness: 0.55,
            flatShading: false,
            side: THREE.DoubleSide,
          });
        }
      });
      return group;
    } catch (e: any) {
      setError(`OBJ parse: ${e?.message ?? e}`);
      return null;
    }
  }, [objText]);

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
  if (!obj) {
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
        camera={{ position: [0, 0, 8], fov: 32 }}
        gl={{ preserveDrawingBuffer: false, antialias: true }}
      >
        <ambientLight intensity={0.55} />
        <directionalLight position={[3, 5, 4]} intensity={1.1} />
        <directionalLight position={[-3, -2, -3]} intensity={0.4} color="#9bb3ff" />
        <Bounds fit clip observe margin={1.15}>
          <primitive object={obj} />
        </Bounds>
        <OrbitControls
          autoRotate={autoRotate}
          autoRotateSpeed={1.2}
          enableZoom={false}
          enablePan={false}
        />
      </Canvas>
    </div>
  );
}
