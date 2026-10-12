import { useEffect } from "react";
import { getProfile } from "../api/client";

export default function ProfilePage() {
  useEffect(() => {
    getProfile();
  }, []);
  return <p>profile</p>;
}
