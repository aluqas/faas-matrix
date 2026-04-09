import { Hono } from "hono";
import type { AppEnv } from "../shared/types";
import roomLifecycleRoutes from "./rooms/lifecycle";
import roomCommandRoutes from "./rooms/commands";
import roomMembershipRoutes from "./rooms/membership";
import roomQueryRoutes from "./rooms/query";
import roomStateRoutes from "./rooms/state";
import roomContextRoutes from "./rooms/context";
import roomDirectoryRoutes from "./rooms/directory";

const app = new Hono<AppEnv>();

app.route("/", roomLifecycleRoutes);
app.route("/", roomCommandRoutes);
app.route("/", roomMembershipRoutes);
app.route("/", roomQueryRoutes);
app.route("/", roomStateRoutes);
app.route("/", roomContextRoutes);
app.route("/", roomDirectoryRoutes);

export default app;
