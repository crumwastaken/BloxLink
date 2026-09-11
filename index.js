const fs = require("fs");
const https = require("https");

const CONFIG = {
    API_BASE: "https://core.bloxgen.net",
    PLATFORM_API_BASE: "https://users.roblox.com/v1/users",
    API_KEY: process.env.BLOXGEN_API_KEY,

    WEBHOOKS: {
        MAIN: process.env.DISCORD_MAIN_WEBHOOK,
        UNWANTED: process.env.DISCORD_UNWANTED_WEBHOOK,
        LOGS: process.env.DISCORD_LOG_WEBHOOK,
        ALL_ACCOUNTS: process.env.DISCORD_ALL_ACCOUNTS_WEBHOOK
    },

    BLOXGEN_LOGO_URL: "https://raw.githubusercontent.com/crumwastaken/BloxLink/1dd60098c6961d6d5ba00bcfb6a4e325a81628b8/Logo.png",
    BOT_NAME: "BloxGen Generator",

    GENERATORS: {
        alt: {
            enabled: true,
            dailyLimit: 50,
            cooldownMs: 30 * 1000
        },

        "30day": {
            enabled: true,
            dailyLimit: 15,
            cooldownMs: 60 * 1000
        },

        "1year": {
            enabled: true,
            dailyLimit: 7,
            cooldownMs: 25 * 60 * 1000
        },

        "5year": {
            enabled: false,
            dailyLimit: 0,
            cooldownMs: 0
        },

        dump: {
            enabled: false,
            dailyLimit: 0,
            cooldownMs: 0
        }
    },

    AUTO_RESTART: false,
    RETRY_DELAY_MS: 5 * 60 * 1000,
    SCHEDULER_INTERVAL_MS: 5 * 1000,
    EMBED_COLOR: 0x5865F2,
    STATE_FILE: "./bloxgen-state.json"
};

const STATE = {
    running: false,
    stopping: false,
    scheduler: null,
    date: getDateKey(),
    dailyCounts: {},
    lastGeneration: {},
    apiRetryUntil: {},
    outOfStock: {}
};

function getDateKey() {
    const now = new Date();

    return [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0")
    ].join("-");
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isUsableValue(value) {
    if (value === undefined || value === null) {
        return false;
    }

    const stringValue = String(value).trim();

    if (!stringValue) {
        return false;
    }

    return ![
        "unknown",
        "_unknown",
        "-",
        "n/a",
        "na",
        "null",
        "undefined"
    ].includes(stringValue.toLowerCase());
}

function displayType(type) {
    return {
        alt: "Alt",
        "30day": "30+ Days",
        "1year": "1+ Year",
        "5year": "5+ Years",
        dump: "Dump"
    }[type] || type;
}

function apiType(type) {
    return {
        alt: "alt",
        "30day": "+30 days old",
        "1year": "+1 year old",
        "5year": "5+ years old",
        dump: "dump"
    }[type];
}

function loadState() {
    try {
        if (!fs.existsSync(CONFIG.STATE_FILE)) {
            return;
        }

        const saved = JSON.parse(
            fs.readFileSync(CONFIG.STATE_FILE, "utf8")
        );

        if (saved.date === getDateKey()) {
            STATE.date = saved.date;
            STATE.dailyCounts = saved.dailyCounts || {};
            STATE.lastGeneration = saved.lastGeneration || {};
        }
    } catch (error) {
        console.log("[STATE] Could not load state:", error.message);
    }
}

function saveState() {
    try {
        fs.writeFileSync(
            CONFIG.STATE_FILE,
            JSON.stringify({
                date: STATE.date,
                dailyCounts: STATE.dailyCounts,
                lastGeneration: STATE.lastGeneration
            }, null, 2)
        );
    } catch (error) {
        console.log("[STATE] Could not save state:", error.message);
    }
}

function resetDailyCountersIfNeeded() {
    const today = getDateKey();

    if (STATE.date === today) {
        return;
    }

    STATE.date = today;
    STATE.dailyCounts = {};
    STATE.lastGeneration = {};
    STATE.apiRetryUntil = {};
    STATE.outOfStock = {};

    saveState();
}

function validateConfig() {
    const missing = [];

    if (!CONFIG.API_KEY) {
        missing.push("BLOXGEN_API_KEY");
    }

    if (!CONFIG.WEBHOOKS.MAIN) {
        missing.push("DISCORD_MAIN_WEBHOOK");
    }

    if (!CONFIG.WEBHOOKS.UNWANTED) {
        missing.push("DISCORD_UNWANTED_WEBHOOK");
    }

    if (!CONFIG.WEBHOOKS.LOGS) {
        missing.push("DISCORD_LOG_WEBHOOK");
    }

    if (!CONFIG.WEBHOOKS.ALL_ACCOUNTS) {
        missing.push("DISCORD_ALL_ACCOUNTS_WEBHOOK");
    }

    if (missing.length) {
        console.error("Missing environment variables:");

        for (const item of missing) {
            console.error(`- ${item}`);
        }

        process.exit(1);
    }

    for (const [type, config] of Object.entries(CONFIG.GENERATORS)) {
        if (!config.enabled) {
            continue;
        }

        if (
            !Number.isFinite(config.dailyLimit) ||
            config.dailyLimit <= 0
        ) {
            console.error(`Invalid daily limit for ${type}.`);
            process.exit(1);
        }

        if (
            !Number.isFinite(config.cooldownMs) ||
            config.cooldownMs < 0
        ) {
            console.error(`Invalid cooldown for ${type}.`);
            process.exit(1);
        }
    }
}

function requestJson(options, body = null) {
    return new Promise((resolve, reject) => {
        const request = https.request(options, response => {
            let data = "";

            response.on("data", chunk => {
                data += chunk;
            });

            response.on("end", () => {
                let parsed = {};

                try {
                    parsed = data ? JSON.parse(data) : {};
                } catch {
                    parsed = { raw: data };
                }

                resolve({
                    statusCode: response.statusCode,
                    headers: response.headers,
                    data: parsed
                });
            });
        });

        request.on("error", reject);

        if (body) {
            request.write(body);
        }

        request.end();
    });
}

async function generateAccount(type) {
    const body = JSON.stringify({
        apiKey: CONFIG.API_KEY,
        type: apiType(type)
    });

    const url = new URL(
        "/api/generate",
        CONFIG.API_BASE
    );

    const started = Date.now();

    console.log(`[BLOXGEN] ${displayType(type)} request started`);

    const response = await requestJson({
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body)
        }
    }, body);

    console.log(
        `[BLOXGEN] ${displayType(type)} response: HTTP ${response.statusCode} (${Date.now() - started}ms)`
    );

    console.log(
        `[BLOXGEN] ${displayType(type)} response body:`,
        JSON.stringify(response.data)
    );

    return response;
}

async function getPlatformUser(id) {
    const url = new URL(
        `${CONFIG.PLATFORM_API_BASE}/${encodeURIComponent(id)}`
    );

    console.log(`[PLATFORM] Lookup started: ${id}`);

    const response = await requestJson({
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: "GET"
    });

    console.log(
        `[PLATFORM] Lookup response: HTTP ${response.statusCode}`
    );

    if (
        response.statusCode < 200 ||
        response.statusCode >= 300 ||
        !response.data ||
        !response.data.created
    ) {
        console.log(
            "[PLATFORM] Lookup body:",
            JSON.stringify(response.data)
        );

        throw new Error(
            `Platform API HTTP ${response.statusCode}`
        );
    }

    return response.data;
}

async function sendWebhook(webhook, payload) {
    if (!webhook) {
        return;
    }

    const url = new URL(webhook);
    const body = JSON.stringify(payload);

    const response = await requestJson({
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body)
        }
    }, body);

    if (response.statusCode >= 400) {
        throw new Error(
            `Discord HTTP ${response.statusCode}`
        );
    }
}

async function sendLogMessage(message) {
    try {
        await sendWebhook(
            CONFIG.WEBHOOKS.LOGS,
            {
                username: CONFIG.BOT_NAME,
                content: message
            }
        );
    } catch (error) {
        console.log("[LOGS] Webhook failed:", error.message);
    }
}

async function sendStartupLog() {
    const fields = [];

    for (const [type, config] of Object.entries(CONFIG.GENERATORS)) {
        if (!config.enabled) {
            continue;
        }

        fields.push({
            name: displayType(type),
            value: `${getCount(type)}/${config.dailyLimit}`,
            inline: true
        });
    }

    const embed = {
        title: "BloxGen Generator",
        description: "BloxGen Generator started.",
        color: CONFIG.EMBED_COLOR,
        fields,
        footer: {
            text: "BloxGen • Automated Generation System"
        },
        timestamp: new Date().toISOString()
    };

    try {
        await sendWebhook(
            CONFIG.WEBHOOKS.LOGS,
            {
                username: CONFIG.BOT_NAME,
                embeds: [embed]
            }
        );
    } catch (error) {
        console.log("[LOGS] Startup webhook failed:", error.message);
    }
}

function getCount(type) {
    return STATE.dailyCounts[type] || 0;
}

function getRemaining(type) {
    return Math.max(
        0,
        CONFIG.GENERATORS[type].dailyLimit - getCount(type)
    );
}

function hasReachedLimit(type) {
    return getRemaining(type) <= 0;
}

function cooldownFinished(type) {
    const last = STATE.lastGeneration[type];

    if (!last) {
        return true;
    }

    return Date.now() - last >= CONFIG.GENERATORS[type].cooldownMs;
}

function apiRetryFinished(type) {
    return Date.now() >= (STATE.apiRetryUntil[type] || 0);
}

function markGeneration(type) {
    STATE.lastGeneration[type] = Date.now();
    STATE.dailyCounts[type] = getCount(type) + 1;
    saveState();
}

function getRateLimitWait(response) {
    const data = response.data || {};

    const values = [
        Number(data.timeRemaining),
        Number(data.retryAfter),
        Number(data.retry_after),
        Number(response.headers?.["retry-after"]) * 1000
    ];

    const valid = values.filter(
        value => Number.isFinite(value) && value > 0
    );

    return valid.length
        ? Math.ceil(Math.max(...valid))
        : CONFIG.RETRY_DELAY_MS;
}

function classifyResponse(response) {
    const status = response.statusCode;
    const data = response.data || {};

    if (status === 429) {
        return "RATE_LIMIT";
    }

    if (
        status >= 200 &&
        status < 300 &&
        data.success === true &&
        data.data
    ) {
        return "SUCCESS";
    }

    if (status >= 200 && status < 300 && data.data) {
        return "SUCCESS";
    }

    const text = JSON.stringify(data).toLowerCase();

    if ([
        "out of stock",
        "out_of_stock",
        "no stock",
        "no accounts",
        "no account",
        "sold out",
        "stock empty",
        "unavailable",
        "inventory empty"
    ].some(value => text.includes(value))) {
        return "NO_STOCK";
    }

    if (data.success === false) {
        return "API_ERROR";
    }

    if (status >= 400) {
        return "HTTP_ERROR";
    }

    return "INVALID_RESPONSE";
}

function routeAccount(platformUser) {
    const created = new Date(platformUser.created);

    return (
        Date.now() - created.getTime() >
        30 * 24 * 60 * 60 * 1000
    )
        ? "MAIN"
        : "UNWANTED";
}

function getAccountAge(createdValue) {
    const created = new Date(createdValue);
    const ageMs = Math.max(0, Date.now() - created.getTime());
    const days = Math.floor(
        ageMs / (24 * 60 * 60 * 1000)
    );

    const years = Math.floor(days / 365);
    const months = Math.floor(days / 30);

    let text;

    if (years >= 1) {
        text = `${years} ${years === 1 ? "year" : "years"} ago`;
    } else if (months >= 1) {
        text = `${months} ${months === 1 ? "month" : "months"} ago`;
    } else {
        text = `${days} ${days === 1 ? "day" : "days"} ago`;
    }

    return {
        unix: Math.floor(created.getTime() / 1000),
        text
    };
}

function createAccountEmbed(account, platformUser, requestedType) {
    const fields = [];

    function addField(name, value, inline = true) {
        if (!isUsableValue(value)) {
            return;
        }

        fields.push({
            name,
            value: String(value).slice(0, 1024),
            inline
        });
    }

    addField("Username", account.username);
    addField("Display Name", platformUser.displayName);

    addField(
        "Type",
        isUsableValue(account.type)
            ? account.type
            : displayType(requestedType)
    );

    addField("ID", account.id);
    addField("Region", account.region);

    addField(
        "Email Verified",
        typeof account.email_verified === "boolean"
            ? account.email_verified ? "Yes" : "No"
            : null
    );

    addField(
        "Age Verified",
        typeof account.age_verified === "boolean"
            ? account.age_verified ? "Yes" : "No"
            : null
    );

    addField(
        "Estimated Age",
        Number.isFinite(Number(account.estimated_age))
            ? `${account.estimated_age} years`
            : null
    );

    addField("Age Group", account.estimated_age_group);

    const age = getAccountAge(platformUser.created);

    addField(
        "Account Age",
        `<t:${age.unix}:R>\n(${age.text})`,
        false
    );

    addField(
        "Status",
        platformUser.isBanned
            ? "BANNED ❌"
            : "Not Banned"
    );

    addField("Cost", account.cost);

    const embed = {
        title: "BloxGen Generator",
        description: "Account generated successfully.",
        color: CONFIG.EMBED_COLOR,
        fields,
        footer: {
            text: "BloxGen • Automated Generation System"
        },
        timestamp: new Date().toISOString()
    };

    const avatar =
        account.fullAvatarUrl ||
        account.avatarUrl;

    if (isUsableValue(avatar)) {
        embed.thumbnail = {
            url: avatar
        };
    }

    if (isUsableValue(CONFIG.BLOXGEN_LOGO_URL)) {
        embed.author = {
            name: CONFIG.BOT_NAME,
            icon_url: CONFIG.BLOXGEN_LOGO_URL
        };
    }

    return embed;
}

function createDetailedAccountMessage(account) {
    return [
        `- **Username:** ${isUsableValue(account.username) ? account.username : ""}`,
        `- **Password:** ${isUsableValue(account.password) ? account.password : ""}`,
        `- **Cookie:** ${isUsableValue(account.cookie) ? account.cookie : ""}`
    ].join("\n");
}

async function postAccount(account, requestedType) {
    const platformUser = await getPlatformUser(account.id);
    const destination = routeAccount(platformUser);

    const webhook =
        destination === "MAIN"
            ? CONFIG.WEBHOOKS.MAIN
            : CONFIG.WEBHOOKS.UNWANTED;

    const embed = createAccountEmbed(
        account,
        platformUser,
        requestedType
    );

    const username = isUsableValue(account.username)
        ? String(account.username)
        : "";

    const password = isUsableValue(account.password)
        ? String(account.password)
        : "";

    await sendWebhook(webhook, {
        username: CONFIG.BOT_NAME,
        content: `${username}:${password}`,
        embeds: [embed]
    });

    await sendWebhook(CONFIG.WEBHOOKS.ALL_ACCOUNTS, {
        username: CONFIG.BOT_NAME,
        content: createDetailedAccountMessage(account),
        embeds: [embed]
    });

    return destination;
}

function isOutOfStock(type) {
    return STATE.outOfStock[type] === true;
}

function markOutOfStock(type) {
    if (STATE.outOfStock[type]) {
        return false;
    }

    STATE.outOfStock[type] = true;
    return true;
}

function getCooldownRemaining(type) {
    const last = STATE.lastGeneration[type];

    if (!last) {
        return 0;
    }

    return Math.max(
        0,
        CONFIG.GENERATORS[type].cooldownMs - (Date.now() - last)
    );
}

async function processGenerator(type) {
    const config = CONFIG.GENERATORS[type];

    if (!config.enabled || isOutOfStock(type) || !STATE.running || STATE.stopping) {
        return;
    }

    if (hasReachedLimit(type)) {
        return;
    }

    if (!cooldownFinished(type) || !apiRetryFinished(type)) {
        return;
    }

    try {
        console.log(`[GENERATOR] ${displayType(type)} generating...`);

        const response = await generateAccount(type);
        const result = classifyResponse(response);

        console.log(
            `[GENERATOR] ${displayType(type)} classified as ${result}`
        );

        if (result === "SUCCESS") {
            const account = response.data.data;

            console.log(
                `[GENERATOR] ${displayType(type)} account received:`,
                JSON.stringify({
                    username: account?.username,
                    id: account?.id,
                    type: account?.type
                })
            );

            markGeneration(type);

            const cooldownRemaining = getCooldownRemaining(type);

            if (cooldownRemaining > 0) {
                console.log(
                    `[COOLDOWN] Waiting ${formatDuration(cooldownRemaining)} for ${displayType(type)} cooldown.`
                );
            }

            try {
                const destination = await postAccount(
                    account,
                    type
                );

                console.log(
                    `[GENERATOR] ${displayType(type)} delivered to ${destination}`
                );

                await sendLogMessage(
                    `${displayType(type)} generated — remaining ${getRemaining(type)}`
                );
            } catch (error) {
                console.log(
                    `[DELIVERY] ${displayType(type)} failed:`,
                    error.message
                );

                await sendLogMessage(
                    `${displayType(type)} generated, but delivery failed`
                );
            }

            return;
        }

        if (result === "RATE_LIMIT") {
            const wait = getRateLimitWait(response);

            STATE.apiRetryUntil[type] = Date.now() + wait;

            console.log(
                `[BLOXGEN] ${displayType(type)} returned HTTP 429. Waiting ${wait}ms.`
            );

            await sendLogMessage(
                `${displayType(type)} waiting for BloxGen API cooldown`
            );

            return;
        }

        if (result === "NO_STOCK") {
            console.log(
                `[BLOXGEN] ${displayType(type)} is out of stock. Disabling generator.`
            );

            if (markOutOfStock(type)) {
                await sendLogMessage(
                    `${displayType(type)} out of stock`
                );
            }

            return;
        }

        console.log(
            `[BLOXGEN] ${displayType(type)} unexpected response:`,
            JSON.stringify(response.data)
        );

        if (CONFIG.AUTO_RESTART) {
            STATE.apiRetryUntil[type] =
                Date.now() + CONFIG.RETRY_DELAY_MS;
        } else {
            await sendLogMessage(
                `${displayType(type)} stopped — BloxGen API error`
            );
        }
    } catch (error) {
        console.log(
            `[GENERATOR] ${displayType(type)} exception:`,
            error.stack || error.message
        );

        if (CONFIG.AUTO_RESTART) {
            STATE.apiRetryUntil[type] =
                Date.now() + CONFIG.RETRY_DELAY_MS;
        } else {
            await sendLogMessage(
                `${displayType(type)} stopped — request error`
            );
        }
    }
}

async function generatorLoop(type) {
    while (STATE.running && !STATE.stopping) {
        resetDailyCountersIfNeeded();

        if (
            !isOutOfStock(type) &&
            !hasReachedLimit(type) &&
            cooldownFinished(type) &&
            apiRetryFinished(type)
        ) {
            await processGenerator(type);
        }

        await sleep(500);
    }
}

async function startGenerator() {
    if (STATE.running) {
        return;
    }

    STATE.running = true;
    STATE.stopping = false;

    await sendStartupLog();

    const enabledTypes = Object.keys(CONFIG.GENERATORS)
        .filter(type => CONFIG.GENERATORS[type].enabled);

    console.log(
        "[START] Enabled generators:",
        enabledTypes.map(displayType).join(", ")
    );

    console.log(
        "[START] Starting all enabled generators independently."
    );

    for (const type of enabledTypes) {
        generatorLoop(type).catch(error => {
            console.error(
                `[LOOP] ${displayType(type)} crashed:`,
                error.stack || error.message
            );
        });
    }
}

async function stopGenerator(reason = "Generator stopped.") {
    if (STATE.stopping) {
        return;
    }

    STATE.stopping = true;
    STATE.running = false;

    if (STATE.scheduler) {
        clearInterval(STATE.scheduler);
        STATE.scheduler = null;
    }

    console.log(`[STOP] ${reason}`);
}

function formatDuration(ms) {
    let seconds = Math.ceil(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    seconds %= 60;

    if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    }

    return `${seconds}s`;
}

function getStatus() {
    const status = {};

    for (const [type, config] of Object.entries(CONFIG.GENERATORS)) {
        if (!config.enabled) {
            continue;
        }

        status[type] = {
            generated: getCount(type),
            limit: config.dailyLimit,
            remaining: getRemaining(type),
            cooldownReady: cooldownFinished(type),
            apiReady: apiRetryFinished(type),
            outOfStock: isOutOfStock(type)
        };
    }

    return status;
}

process.on("SIGINT", async () => {
    await stopGenerator("Generator stopped manually.");
    process.exit(0);
});

process.on("SIGTERM", async () => {
    await stopGenerator("Generator terminated.");
    process.exit(0);
});

async function main() {
    validateConfig();
    loadState();
    resetDailyCountersIfNeeded();

    console.log("[STATUS]", JSON.stringify(getStatus(), null, 2));

    await startGenerator();
}

main().catch(async error => {
    console.error("[FATAL]", error.stack || error.message);

    await sendLogMessage("Fatal generator error");
    process.exit(1);
});
