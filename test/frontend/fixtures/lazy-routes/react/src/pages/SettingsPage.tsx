import { useEffect } from "react";
import { getSettings } from "../api/client";

export default function SettingsPage() {
  useEffect(() => {
    getSettings();
  }, []);
  return <p>settings</p>;
}
