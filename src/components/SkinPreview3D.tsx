import { useEffect, useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Bounds, OrbitControls } from "@react-three/drei";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import * as THREE from "three";
import { ipc, type SkinPreviewBundle } from "../lib/ipc";

function base64ToBlobUrl(b64: string): string {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
}

type MtlMeta = { map_Kd?: string; Kd?: [number, number, number] };

function parseMtl(mtl: string): Map<string, MtlMeta> {
  const out = new Map<string, MtlMeta>();
  let cur: MtlMeta | null = null;
  let curName = "";
  for (const line of mtl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts[0] === "newmtl") {
      if (cur) out.set(curName, cur);
      curName = parts[1] ?? "";
      cur = {};
    } else if (cur && parts[0] === "map_Kd") {
      cur.map_Kd = parts.slice(1).join(" ");
    } else if (cur && parts[0] === "Kd" && parts.length >= 4) {
      cur.Kd = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
    }
  }
  if (cur && curName) out.set(curName, cur);
  return out;
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setBundle(null);
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

  const parsed = useMemo(() => {
    if (!bundle) return null;

    const blobUrls: string[] = [];
    const nameToBlob = new Map<string, string>();
    for (const [name, b64] of Object.entries(bundle.textures)) {
      const url = base64ToBlobUrl(b64);
      blobUrls.push(url);
      nameToBlob.set(name, url);
    }

    try {
      const matMeta = parseMtl(bundle.mtl);

      const ownedTextures: THREE.Texture[] = [];
      const texLoader = new THREE.TextureLoader();
      const matToTexture = new Map<string, THREE.Texture | null>();
      for (const [name, meta] of matMeta) {
        if (!meta.map_Kd) {
          matToTexture.set(name, null);
          continue;
        }
        const url = nameToBlob.get(meta.map_Kd);
        if (!url) {
          matToTexture.set(name, null);
          continue;
        }
        const tex = texLoader.load(url);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.flipY = true;
        ownedTextures.push(tex);
        matToTexture.set(name, tex);
      }

      const objLoader = new OBJLoader();
      const group = objLoader.parse(bundle.obj);

      group.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const m = child as THREE.Mesh;
          const geom = m.geometry as THREE.BufferGeometry;
          const hasVertColors = geom.getAttribute("color") != null;
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          const replaced = mats.map((mat) => {
            const matName = (mat as THREE.Material).name;
            const tex = matToTexture.get(matName) ?? null;
            const meta = matMeta.get(matName);
            const kd = meta?.Kd ?? [0.8, 0.8, 0.85];
            return new THREE.MeshStandardMaterial({
              name: matName,
              color: tex
                ? 0xffffff
                : hasVertColors
                  ? 0xffffff
                  : new THREE.Color(kd[0], kd[1], kd[2]),
              map: tex,
              vertexColors: !tex && hasVertColors,
              metalness: 0.05,
              roughness: 0.55,
              side: THREE.DoubleSide,
            });
          });
          for (const orig of mats) (orig as THREE.Material).dispose?.();
          m.material = Array.isArray(m.material) ? replaced : replaced[0];
        }
      });

      return { group, blobUrls, ownedTextures };
    } catch (e: any) {
      blobUrls.forEach((u) => URL.revokeObjectURL(u));
      setError(`preview parse: ${e?.message ?? e}`);
      return null;
    }
  }, [bundle]);

  useEffect(() => {
    return () => {
      if (!parsed) return;
      parsed.blobUrls.forEach((u) => URL.revokeObjectURL(u));
      parsed.ownedTextures.forEach((t) => t.dispose());
      parsed.group.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const m = child as THREE.Mesh;
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          for (const mat of mats) (mat as THREE.Material).dispose?.();
          (m.geometry as THREE.BufferGeometry).dispose?.();
        }
      });
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
  if (!parsed) {
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
          <primitive object={parsed.group} />
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
