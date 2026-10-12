import type { ReactNode } from "react";

export function Protected({ children }: { children: ReactNode }) {
  return <div className="protected">{children}</div>;
}
