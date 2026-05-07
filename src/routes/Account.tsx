import { Library } from "./Library";
import { Settings } from "./Settings";

/// Unified "my stuff" page — installed skins + settings + patreon
/// account state, all on one scroll. Replaces the old Library and
/// Settings routes so the top bar only needs one entry point. Both
/// child components keep their own internal data fetching and
/// `onChange` / `onAfterAction` callbacks; Account just wires them
/// to a single upstream callback.
export function Account({ onAfterAction }: { onAfterAction?: () => void }) {
  return (
    <div className="divide-y divide-border/40">
      <Library onAfterAction={onAfterAction} />
      <Settings onChange={onAfterAction} />
    </div>
  );
}
