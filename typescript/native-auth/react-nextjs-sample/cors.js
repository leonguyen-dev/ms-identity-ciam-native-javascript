const http = require("http");
const https = require("https");
const url = require("url");
const proxyConfig = require("./proxy.config");

/**
 * Local-dev mirror of the server-side sign-up attribute validation.
 *
 * In production this runs in the SWA function (api/src/attributeValidation.ts, invoked
 * by authProxy.ts). Locally cors.js is the /api proxy, so the same /api/validate-attributes
 * call must be answered here. KEEP THIS IN SYNC with api/src/attributeValidation.ts.
 */
const MIN_AGE = 16;
const MAX_AGE = 120;
const NAME_MAX = 64;
const HAS_LETTER = /\p{L}/u;

function hasForbiddenChar(value) {
    if (value.includes("<") || value.includes(">")) {
        return true;
    }
    for (const ch of value) {
        if (ch.charCodeAt(0) < 0x20) {
            return true;
        }
    }
    return false;
}

function validateName(value, field, label, errors) {
    const v = typeof value === "string" ? value.trim() : "";
    if (v.length === 0) {
        errors[field] = `Please provide your ${label}.`;
        return;
    }
    if (v.length > NAME_MAX) {
        errors[field] = `Your ${label} must be ${NAME_MAX} characters or fewer.`;
        return;
    }
    if (hasForbiddenChar(v) || !HAS_LETTER.test(v)) {
        errors[field] = `Please enter a valid ${label}.`;
    }
}

function ageOn(dob, now) {
    let age = now.getUTCFullYear() - dob.getUTCFullYear();
    const monthDelta = now.getUTCMonth() - dob.getUTCMonth();
    if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.getUTCDate())) {
        age--;
    }
    return age;
}

function validateDateOfBirth(value, errors) {
    if (typeof value !== "string" || value.trim().length === 0) {
        errors.dateOfBirth = "Please provide your date of birth.";
        return;
    }
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match) {
        errors.dateOfBirth = "Please enter a valid date of birth.";
        return;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const dob = new Date(Date.UTC(year, month - 1, day));
    if (dob.getUTCFullYear() !== year || dob.getUTCMonth() !== month - 1 || dob.getUTCDate() !== day) {
        errors.dateOfBirth = "Please enter a valid date of birth.";
        return;
    }
    const now = new Date();
    if (dob.getTime() > now.getTime()) {
        errors.dateOfBirth = "Your date of birth can't be in the future.";
        return;
    }
    const age = ageOn(dob, now);
    if (age < MIN_AGE) {
        errors.dateOfBirth = `You must be at least ${MIN_AGE} years old to create an account.`;
        return;
    }
    if (age > MAX_AGE) {
        errors.dateOfBirth = "Please enter a valid date of birth.";
    }
}

function validateSignUpAttributes(input) {
    const errors = {};
    const data = input || {};
    validateName(data.givenName, "givenName", "given name", errors);
    validateName(data.surname, "surname", "family name", errors);
    validateDateOfBirth(data.dateOfBirth, errors);
    if (data.termsAccepted !== true) {
        errors.termsAccepted = "You must agree to the terms and conditions.";
    }
    const valid = Object.keys(errors).length === 0;
    return { valid, errors, message: valid ? undefined : Object.values(errors)[0] };
}

const extraHeaders = [
    "x-client-SKU",
    "x-client-VER",
    "x-client-OS",
    "x-client-CPU",
    "x-client-current-telemetry",
    "x-client-last-telemetry",
    "client-request-id",
];
http.createServer((req, res) => {
    const reqUrl = url.parse(req.url);
    const domain = url.parse(proxyConfig.proxy).hostname;

    // Set CORS headers for all responses including OPTIONS
    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, " + extraHeaders.join(", "),
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Max-Age": "86400", // 24 hours
    };

    // Handle preflight OPTIONS request
    if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
    }

    // Server-side attribute validation endpoint — answered locally, not proxied to CIAM.
    if (req.method === "POST" && reqUrl.pathname === `${proxyConfig.localApiPath}/validate-attributes`) {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
            let result;
            try {
                result = validateSignUpAttributes(JSON.parse(raw || "{}"));
            } catch (err) {
                result = { valid: false, errors: {}, message: "Invalid request body." };
            }
            res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
        });
        return;
    }

    if (reqUrl.pathname.startsWith(proxyConfig.localApiPath)) {
        const targetUrl = proxyConfig.proxy + reqUrl.pathname?.replace(proxyConfig.localApiPath, "") + (reqUrl.search || "");

        console.log("Incoming request -> " + req.url + " ===> " + reqUrl.pathname);

        const newHeaders = {};
        for (let [key, value] of Object.entries(req.headers)) {
            if (key !== 'origin') {
                newHeaders[key] = value;
            }
        }

        const proxyReq = https.request(
            targetUrl, // CodeQL [SM04580] The newly generated target URL utilizes the configured proxy URL to resolve the CORS issue and will be used exclusively for demo purposes and run locally.
            {
                method: req.method,
                headers: {
                    ...newHeaders,
                    host: domain,
                },
            },
            (proxyRes) => {
                res.writeHead(proxyRes.statusCode, {
                    ...proxyRes.headers,
                    ...corsHeaders,
                });

                proxyRes.pipe(res);
            }
        );

        proxyReq.on("error", (err) => {
            console.error("Error with the proxy request:", err);
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Proxy error.");
        });

        req.pipe(proxyReq);
    } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
    }
}).listen(proxyConfig.port, () => {
    console.log("CORS proxy running on http://localhost:3001");
    console.log("Proxying from " + proxyConfig.localApiPath + " ===> " + proxyConfig.proxy);
});
