import { useEffect, useState } from "react";

export type Toast = {
  id: number;
  kind: "ok" | "danger" | "info";
  text: string;
};

let pushImpl: ((t: Omit<Toast, "id">) => void) | null = null;
let nextId = 1;

export function toast(t: Omit<Toast, "id">) {
  pushImpl?.(t);
}

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);

  useEffect(() => {
    pushImpl = (t) => {
      const id = nextId++;
      setItems((s) => [...s, { ...t, id }]);
      setTimeout(() => {
        setItems((s) => s.filter((x) => x.id !== id));
      }, 4500);
    };
    return () => {
      pushImpl = null;
    };
  }, []);

  return (
    <div className="fixed bottom-4 right-4 z-50 space-y-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={`card px-4 py-2 text-sm max-w-sm shadow-lg ${
            t.kind === "danger"
              ? "border-danger/50 text-danger"
              : t.kind === "ok"
              ? "border-ok/50 text-ok"
              : ""
          }`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
