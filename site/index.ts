import { respond } from "./handler.js";
import { INSTALL_SCRIPT } from "./install-script.js";

export default {
  fetch(request: Request): Response {
    return respond(request, INSTALL_SCRIPT);
  },
};
