export async function getOrders() {
  const r = await fetch("/api/orders");
  return r.json();
}
export async function getReports() {
  const r = await fetch("/api/reports");
  return r.json();
}
export async function getProfile() {
  const r = await fetch("/api/profile");
  return r.json();
}
export async function getSettings() {
  const r = await fetch("/api/settings");
  return r.json();
}
export async function getCatalog() {
  const r = await fetch("/api/catalog");
  return r.json();
}
export async function getUsers() {
  const r = await fetch("/api/admin/users");
  return r.json();
}
