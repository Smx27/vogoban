import { useEffect } from "react";
import { getReports } from "../api/client";

export function ReportsPage() {
  useEffect(() => {
    getReports();
  }, []);
  return <p>reports</p>;
}
