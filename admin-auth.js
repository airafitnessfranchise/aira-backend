const crypto = require("crypto");

// Shared Basic access is an optional recovery credential, never a default.
// Normal browser access uses the short-lived staff token from Aira Admin.
const MIN_RECOVERY_PASSWORD_LENGTH = 32;

function equalSecret(left, right) {
  const digest = (value) =>
    crypto.createHash("sha256").update(value, "utf8").digest();
  return crypto.timingSafeEqual(digest(left), digest(right));
}

function createAdminAuth({ verifyStaffToken, normalizeLocationId, env = process.env }) {
  return function adminAuth(req, res, next) {
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");

    const authorization = req.headers.authorization || "";
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
    const token = req.query?.staff_token || bearer?.[1];
    if (typeof token === "string" && token && env.RECORDER_TOKEN_SECRET) {
      try {
        const payload = verifyStaffToken(token);
        req.staffToken = token;
        req.staff = {
          email: payload.email,
          name: payload.name,
          role: payload.role,
          location_ids: Array.isArray(payload.location_ids)
            ? payload.location_ids.map(normalizeLocationId)
            : [],
          is_super: payload.role === "super_admin",
        };
        return next();
      } catch {
        // Do not log bearer credentials or parser messages containing input.
      }
    }

    const password = env.ADMIN_PASSWORD;
    const recoveryEnabled =
      typeof password === "string" &&
      password.trim().length >= MIN_RECOVERY_PASSWORD_LENGTH;
    const basic = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
    if (recoveryEnabled && basic) {
      const decoded = Buffer.from(basic[1], "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      const user = separator >= 0 ? decoded.slice(0, separator) : "";
      const supplied = separator >= 0 ? decoded.slice(separator + 1) : "";
      if (user === "admin" && equalSecret(supplied, password)) {
        req.staff = {
          email: "admin@local",
          name: "Aira Admin",
          role: "super_admin",
          location_ids: [],
          is_super: true,
        };
        return next();
      }
    }

    if (recoveryEnabled) {
      res.set("WWW-Authenticate", 'Basic realm="Aira Admin"');
    }
    return res
      .status(401)
      .send("Authentication required. Open Scorecards from Aira Admin to sign in.");
  };
}

module.exports = { createAdminAuth, MIN_RECOVERY_PASSWORD_LENGTH };
