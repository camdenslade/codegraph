import { getUser, listUsers } from "./handlers.js";

const app: any = {};

app.get("/users", listUsers);
app.get("/users/:id", getUser);
app.post("/users", (req: any, res: any) => res.end());
