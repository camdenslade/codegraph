import { Base } from "./base.js";
import { add } from "./math.js";

export interface Shape {
  area(): number;
}

export class Circle extends Base implements Shape {
  constructor(public r: number) {
    super();
  }

  area(): number {
    return add(this.r, this.r);
  }
}