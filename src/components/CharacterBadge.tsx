type Pair = [string, string];

const PALETTE: Record<string, Pair> = {
  Fx: ["#fb923c", "#dc2626"],
  Fc: ["#f472b6", "#7c3aed"],
  Mr: ["#ef4444", "#b45309"],
  Lg: ["#34d399", "#059669"],
  Ca: ["#3b82f6", "#3730a3"],
  Mt: ["#60a5fa", "#1d4ed8"],
  Cl: ["#f43f5e", "#b91c1c"],
  Sk: ["#a78bfa", "#6d28d9"],
  Zd: ["#f9a8d4", "#a21caf"],
  Pe: ["#f9a8d4", "#ec4899"],
  Pk: ["#fde047", "#eab308"],
  Pc: ["#fef08a", "#f59e0b"],
  Pp: ["#d8b4fe", "#7e22ce"],
  Ys: ["#4ade80", "#16a34a"],
  Kb: ["#fbcfe8", "#f472b6"],
  Lk: ["#34d399", "#047857"],
  Ne: ["#4ade80", "#16a34a"],
  Nn: ["#f87171", "#dc2626"],
  Ss: ["#fdba74", "#d97706"],
  Dk: ["#92400e", "#78350f"],
  Kp: ["#eab308", "#a16207"],
  Pr: ["#fbcfe8", "#fda4af"],
  Gn: ["#7e22ce", "#581c87"],
  Ic: ["#7dd3fc", "#0ea5e9"],
  Gw: ["#3f3f46", "#18181b"],
  Mh: ["#fda4af", "#f43f5e"],
};

export function CharacterBadge({
  code,
  size = 56,
}: {
  code: string;
  size?: number;
}) {
  const [a, b] = PALETTE[code] ?? ["#71717a", "#3f3f46"];
  const fontSize = Math.round(size * 0.42);
  return (
    <div
      className="flex-shrink-0 rounded-full text-white font-bold flex items-center justify-center shadow-inner select-none"
      style={{
        width: size,
        height: size,
        fontSize,
        background: `linear-gradient(135deg, ${a}, ${b})`,
        textShadow: "0 1px 2px rgba(0,0,0,0.4)",
        letterSpacing: "0.04em",
      }}
      aria-hidden
    >
      {code.toUpperCase()}
    </div>
  );
}
