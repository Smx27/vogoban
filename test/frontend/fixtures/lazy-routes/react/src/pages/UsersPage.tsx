import { useEffect } from "react";
import { getUsers } from "../api/client";

export default function UsersPage() {
  useEffect(() => {
    getUsers();
  }, []);
  return <p>users</p>;
}
