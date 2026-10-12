export function stripGenerics(name: string): string {
  let current = name;
  for (let previous = ""; previous !== current; ) [previous, current] = [current, current.replace(/<[^<>]*>/g, "")];
  return current;
}

export function memberPath(qualifiedName: string): string {
  let name = qualifiedName;
  if (name.endsWith(")")) {
    let depth = 0;
    for (let i = name.length - 1; i >= 0; i--) {
      if (name[i] === ")") depth++;
      else if (name[i] === "(" && --depth === 0) {
        name = name.slice(0, i);
        break;
      }
    }
  }
  return stripGenerics(name.replace(/\([^()]*\)/g, ""));
}

