import { readFileSync } from "node:fs";
import { add } from "./math.js";
import { Circle } from "./shape.js";

export function main(): number {
  const c = new Circle(2);
  const dynamic: any = {};
  dynamic.mystery(); // unresolved: any-typed callee
  return add(c.area(), readFileSync ? 1 : 0);
}