import script from "../install.sh";
import { respond } from "./handler.js";

export default {
  fetch(request: Request): Response {
    return respond(request, script);
  },
};
