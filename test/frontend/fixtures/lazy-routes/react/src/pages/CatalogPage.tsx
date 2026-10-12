import { useEffect } from "react";
import { getCatalog } from "../api/client";

export default function CatalogPage() {
  useEffect(() => {
    getCatalog();
  }, []);
  return <p>catalog</p>;
}
