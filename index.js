const fs = require("fs");
const https = require("https");

/*

Vibe coded by crumwastaken enjoy if your gonna use this

===========================================================
 BloxGen Generator
===========================================================

 Required .env variables:

 BLOXGEN_API_KEY=
 DISCORD_MAIN_WEBHOOK=
 DISCORD_UNWANTED_WEBHOOK=
 DISCORD_LOG_WEBHOOK=

===========================================================
*/


/* =========================================================
   CONFIG
========================================================= */

const CONFIG = {

    API_BASE: "https://core.bloxgen.net",
    PLATFORM_API_BASE: "https://roblox.com/v1/users",

    API_KEY: process.env.BLOXGEN_API_KEY,

    WEBHOOKS: {
        MAIN: process.env.DISCORD_MAIN_WEBHOOK,
        UNWANTED: process.env.DISCORD_UNWANTED_WEBHOOK,
        LOGS: process.env.DISCORD_LOG_WEBHOOK,
        ALL_ACCOUNTS: process.env.DISCORD_ALL_ACCOUNTS_WEBHOOK
    },

    BLOXGEN_LOGO_URL: "https://raw.githubusercontent.com/crumwastaken/BloxLink/1dd60098c6961d6d5ba00bcfb6a4e325a81628b8/Logo.png",

    BOT_NAME: "BloxGen Generator",

    /*
     * Generator configuration.
     *
     * Only +30 days is enabled by default.
     */
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

        /*
         * These were not given a daily limit/cooldown
         * in the supplied documentation, so they remain
         * disabled until configured.
         */
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

    /*
     * If false:
     *
     *   No stock
     *   Rate limit
     *   API error
     *   etc.
     *
     * will stop the generator.
     *
     * If true:
     *
     * the script waits and tries again.
     */
    AUTO_RESTART: false,

    /*
     * Time between retries when AUTO_RESTART is enabled.
     */
    RETRY_DELAY_MS: 5 * 60 * 1000,

    /*
     * How often the scheduler checks whether a generator
     * is ready.
     *
     * This does NOT bypass cooldowns.
     */
    SCHEDULER_INTERVAL_MS: 5 * 1000,

    /*
     * Discord embed colour.
     */
    EMBED_COLOR: 0x5865F2,

    /*
     * Persistent state file.
     *
     * Daily counters survive a process restart.
     */
    STATE_FILE: "./bloxgen-state.json"
};


/* =========================================================
   VALIDATE CONFIG
========================================================= */

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

    if (missing.length > 0) {

        console.error(
            "Missing .env variables:"
        );

        for (const item of missing) {
            console.error(`- ${item}`);
        }

        process.exit(1);
    }

    /*
     * Make sure enabled generators actually have
     * usable limits/cooldowns.
     */
    for (
        const [type, config]
        of Object.entries(CONFIG.GENERATORS)
    ) {

        if (!config.enabled) {
            continue;
        }

        if (
            !Number.isFinite(config.dailyLimit) ||
            config.dailyLimit <= 0
        ) {

            console.error(
                `Generator "${type}" has an invalid daily limit.`
            );

            process.exit(1);
        }

        if (
            !Number.isFinite(config.cooldownMs) ||
            config.cooldownMs < 0
        ) {

            console.error(
                `Generator "${type}" has an invalid cooldown.`
            );

            process.exit(1);
        }
    }
}


/* =========================================================
   DATE HELPERS
========================================================= */

function getDateKey() {

    const now = new Date();

    return [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0")
    ].join("-");
}


/* =========================================================
   STATE
========================================================= */

const STATE = {

    running: false,

    stopping: false,

    generationInProgress: false,

    scheduler: null,

    date: getDateKey(),

    dailyCounts: {},

    lastGeneration: {},

    dailyLimitAnnounced: {},

    retrying: false
};


function loadState() {

    try {

        if (!fs.existsSync(CONFIG.STATE_FILE)) {
            return;
        }

        const saved =
            JSON.parse(
                fs.readFileSync(
                    CONFIG.STATE_FILE,
                    "utf8"
                )
            );

        if (
            saved.date === getDateKey()
        ) {

            STATE.date = saved.date;

            STATE.dailyCounts =
                saved.dailyCounts || {};

            STATE.lastGeneration =
                saved.lastGeneration || {};
        }

    } catch (error) {

        console.log(
            `Could not load state file: ${error.message}`
        );
    }
}


function saveState() {

    try {

        fs.writeFileSync(
            CONFIG.STATE_FILE,

            JSON.stringify(
                {
                    date: STATE.date,
                    dailyCounts:
                        STATE.dailyCounts,
                    lastGeneration:
                        STATE.lastGeneration
                },
                null,
                2
            )
        );

    } catch (error) {

        console.log(
            `Could not save state: ${error.message}`
        );
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

    STATE.dailyLimitAnnounced = {};

    saveState();

    operationalLog(
        "INFO",
        "Daily generation counters have been reset."
    );
}


/* =========================================================
   GENERAL HELPERS
========================================================= */

function sleep(ms) {

    return new Promise(
        resolve => setTimeout(resolve, ms)
    );
}


function isUsableValue(value) {

    if (
        value === undefined ||
        value === null
    ) {
        return false;
    }

    const stringValue =
        String(value).trim();

    if (!stringValue) {
        return false;
    }

    const invalidValues = [
        "unknown",
        "_unknown",
        "-",
        "n/a",
        "na",
        "null",
        "undefined"
    ];

    return !invalidValues.includes(
        stringValue.toLowerCase()
    );
}


function displayType(type) {

    const names = {

        alt: "Alt",

        "30day": "30+ Days",

        "1year": "1+ Year",

        "5year": "5+ Years",

        dump: "Dump"
    };

    return names[type] || type;
}


function apiType(type) {

    /*
     * These are based on the account types supplied
     * in the BloxGen documentation.
     */

    const types = {

        alt: "alt",

        "30day": "+30 days old",

        "1year": "+1 year old",

        "5year": "5+ years old",

        dump: "dump"
    };

    return types[type];
}


/* =========================================================
   HTTP
========================================================= */

function requestJson(
    options,
    body = null
) {

    return new Promise(
        (resolve, reject) => {

            const request =
                https.request(
                    options,
                    response => {

                        let data = "";

                        response.on(
                            "data",
                            chunk => {
                                data += chunk;
                            }
                        );

                        response.on(
                            "end",
                            () => {

                                let parsed;

                                try {

                                    parsed =
                                        data
                                            ? JSON.parse(data)
                                            : {};

                                } catch {

                                    parsed = {
                                        raw: data
                                    };
                                }

                                resolve({
                                    statusCode:
                                        response.statusCode,

                                    headers:
                                        response.headers,

                                    data: parsed
                                });
                            }
                        );
                    }
                );

            request.on(
                "error",
                reject
            );

            if (body) {
                request.write(body);
            }

            request.end();
        }
    );
}


/* =========================================================
   BLOXGEN API
========================================================= */

async function generateAccount(type) {

    const body =
        JSON.stringify({
            apiKey: CONFIG.API_KEY,
            type: apiType(type)
        });

    const url =
        new URL(
            "/api/generate",
            CONFIG.API_BASE
        );

    return requestJson(
        {
            hostname: url.hostname,

            port: 443,

            path:
                url.pathname +
                url.search,

            method: "POST",

            headers: {
                "Content-Type":
                    "application/json",

                "Content-Length":
                    Buffer.byteLength(body)
            }
        },

        body
    );
}


async function getPlatformUser(id) {
    const url =
        new URL(
            `${CONFIG.PLATFORM_API_BASE}/${encodeURIComponent(id)}`
        );

    const response =
        await requestJson({
            hostname: url.hostname,
            port: 443,
            path:
                url.pathname +
                url.search,
            method: "GET"
        });

    if (
        response.statusCode < 200 ||
        response.statusCode >= 300 ||
        !response.data ||
        !response.data.created
    ) {
        throw new Error(
            `Platform API returned HTTP ${response.statusCode}`
        );
    }

    const created =
        new Date(response.data.created);

    if (Number.isNaN(created.getTime())) {
        throw new Error(
            "Platform API returned an invalid created date"
        );
    }

    return response.data;
}

/* =========================================================
   DISCORD
========================================================= */

async function sendWebhook(
    webhook,
    payload
) {

    if (!webhook) {
        return;
    }

    const url =
        new URL(webhook);

    const body =
        JSON.stringify(payload);

    const response =
        await requestJson(
            {
                hostname: url.hostname,

                port: 443,

                path:
                    url.pathname +
                    url.search,

                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json",

                    "Content-Length":
                        Buffer.byteLength(body)
                }
            },

            body
        );

    if (
        response.statusCode >= 400
    ) {

        throw new Error(
            `Discord returned HTTP ${response.statusCode}`
        );
    }
}


/* =========================================================
   OPERATIONAL LOGS
========================================================= */

async function operationalLog(
    level,
    message,
    details = {}
) {

    const timestamp =
        new Date().toISOString();

    console.log(
        `[${timestamp}] [${level}] ${message}`
    );

    const fields = [];

    for (
        const [name, value]
        of Object.entries(details)
    ) {

        if (
            !isUsableValue(value)
        ) {
            continue;
        }

        fields.push({
            name: String(name),
            value:
                String(value)
                    .slice(0, 1024),
            inline: true
        });
    }

    const colors = {

        INFO: 0x57F287,

        WARNING: 0xFEE75C,

        ERROR: 0xED4245
    };

    const embed = {

        title:
            `${CONFIG.BOT_NAME} â¢ ${level}`,

        description:
            String(message)
                .slice(0, 4096),

        color:
            colors[level] ||
            CONFIG.EMBED_COLOR,

        fields,

        footer: {
            text:
                "Operational Log â¢ BloxGen Generator"
        },

        timestamp
    };

    try {

        await sendWebhook(
            CONFIG.WEBHOOKS.LOGS,

            {
                username:
                    CONFIG.BOT_NAME,

                embeds: [
                    embed
                ]
            }
        );

    } catch (error) {

        console.log(
            `[LOGGING ERROR] ${error.message}`
        );
    }
}


/* =========================================================
   ACCOUNT ROUTING
========================================================= */

function routeAccount(
    platformUser
) {
    const created =
        new Date(platformUser.created);

    const ageMs =
        Date.now() - created.getTime();

    return ageMs > 30 * 24 * 60 * 60 * 1000
        ? "MAIN"
        : "UNWANTED";
}

/* =========================================================
   ACCOUNT EMBED
========================================================= */

function createAccountEmbed(
    account,
    platformUser,
    requestedType
) {
    const fields = [];

    function addField(
        name,
        value,
        inline = true
    ) {
        if (
            !isUsableValue(value)
        ) {
            return;
        }

        fields.push({
            name,
            value:
                String(value)
                    .slice(0, 1024),
            inline
        });
    }

    addField(
        "Username",
        account.username
    );

    addField(
        "Display Name",
        platformUser.displayName
    );

    addField(
        "Type",
        isUsableValue(account.type)
            ? account.type
            : displayType(requestedType)
    );

    addField(
        "ID",
        account.id
    );

    addField(
        "Region",
        account.region
    );

    addField(
        "Email Verified",
        typeof account.email_verified ===
        "boolean"
            ? account.email_verified
                ? "Yes"
                : "No"
            : null
    );

    addField(
        "Age Verified",
        typeof account.age_verified ===
        "boolean"
            ? account.age_verified
                ? "Yes"
                : "No"
            : null
    );

    addField(
        "Estimated Age",
        Number.isFinite(
            Number(account.estimated_age)
        )
            ? `${account.estimated_age} years`
            : null
    );

    addField(
        "Age Group",
        account.estimated_age_group
    );

    const created =
        new Date(platformUser.created);

    const unix =
        Math.floor(
            created.getTime() / 1000
        );

    const ageMs =
        Math.max(
            0,
            Date.now() - created.getTime()
        );

    const days =
        Math.floor(
            ageMs / (24 * 60 * 60 * 1000)
        );

    const years =
        Math.floor(days / 365);

    const months =
        Math.floor(days / 30);

    let ageText;

    if (years >= 1) {
        ageText =
            `${years} ${years === 1 ? "year" : "years"} ago`;
    } else if (months >= 1) {
        ageText =
            `${months} ${months === 1 ? "month" : "months"} ago`;
    } else {
        ageText =
            `${days} ${days === 1 ? "day" : "days"} ago`;
    }

    addField(
        "Account Age",
        `<t:${unix}:R>\n(${ageText})`,
        false
    );

    addField(
        "Status",
        platformUser.isBanned
            ? "BANNED â"
            : "Not Banned"
    );

    addField(
        "Cost",
        isUsableValue(account.cost)
            ? account.cost
            : null
    );

    const embed = {
        title:
            "BloxGen Generator",
        description:
            "Account generated successfully.",
        color:
            CONFIG.EMBED_COLOR,
        fields,
        footer: {
            text:
                "BloxGen â¢ Automated Generation System"
        },
        timestamp:
            new Date().toISOString()
    };

    const avatar =
        account.fullAvatarUrl ||
        account.avatarUrl;

    if (
        isUsableValue(avatar)
    ) {
        embed.thumbnail = {
            url: avatar
        };
    }

    if (
        isUsableValue(
            CONFIG.BLOXGEN_LOGO_URL
        )
    ) {
        embed.author = {
            name:
                CONFIG.BOT_NAME,
            icon_url:
                CONFIG.BLOXGEN_LOGO_URL
        };
    }

    return embed;
}

/* =========================================================
   RAW ACCOUNT MESSAGE
========================================================= */

function createDetailedAccountMessage(
    account
) {
    const username =
        isUsableValue(account.username)
            ? String(account.username)
            : "";

    const password =
        isUsableValue(account.password)
            ? String(account.password)
            : "";

    const cookie =
        isUsableValue(account.cookie)
            ? String(account.cookie)
            : "";

    return [
        `- **Username:** ${username}`,
        `- **Password:** ${password}`,
        `- **Cookie:** ${cookie}`
    ].join("\n");
}

/* =========================================================
   POST ACCOUNT
========================================================= */

async function postAccount(
    account,
    requestedType
) {
    const platformUser =
        await getPlatformUser(
            account.id
        );

    const destination =
        routeAccount(
            platformUser
        );

    const webhook =
        destination === "MAIN"
            ? CONFIG.WEBHOOKS.MAIN
            : CONFIG.WEBHOOKS.UNWANTED;

    const username =
        isUsableValue(account.username)
            ? String(account.username)
            : "";

    const password =
        isUsableValue(account.password)
            ? String(account.password)
            : "";

    const compactContent =
        `${username}:${password}`;

    const embed =
        createAccountEmbed(
            account,
            platformUser,
            requestedType
        );

    await sendWebhook(
        webhook,
        {
            username:
                CONFIG.BOT_NAME,
            content:
                compactContent,
            embeds: [
                embed
            ]
        }
    );

    const detailedContent =
        createDetailedAccountMessage(
            account
        );

    await sendWebhook(
        CONFIG.WEBHOOKS.ALL_ACCOUNTS,
        {
            username:
                CONFIG.BOT_NAME,
            content:
                detailedContent,
            embeds: [
                embed
            ]
        }
    );

    return destination;
}

/* =========================================================
   GENERATION COUNTERS
========================================================= */

function getCount(type) {

    return STATE.dailyCounts[type] || 0;
}


function getRemaining(type) {

    const config =
        CONFIG.GENERATORS[type];

    return Math.max(
        0,
        config.dailyLimit -
        getCount(type)
    );
}


function hasReachedLimit(type) {

    return (
        getRemaining(type) <= 0
    );
}


function cooldownFinished(type) {

    const config =
        CONFIG.GENERATORS[type];

    const last =
        STATE.lastGeneration[type];

    if (!last) {
        return true;
    }

    return (
        Date.now() - last
        >= config.cooldownMs
    );
}


function markGeneration(type) {

    STATE.lastGeneration[type] =
        Date.now();

    STATE.dailyCounts[type] =
        getCount(type) + 1;

    saveState();
}


/* =========================================================
   DAILY LIMIT NOTIFICATION
========================================================= */

async function announceDailyLimit(
    type
) {

    if (
        STATE.dailyLimitAnnounced[type]
    ) {
        return;
    }

    STATE.dailyLimitAnnounced[type] =
        true;

    await operationalLog(
        "WARNING",

        `${displayType(type)} daily limit reached.`,

        {
            Type:
                displayType(type),

            Generated:
                getCount(type),

            Limit:
                CONFIG.GENERATORS[type]
                    .dailyLimit
        }
    );
}


/* =========================================================
   API RESPONSE CLASSIFICATION
========================================================= */

function classifyResponse(
    response
) {

    const status =
        response.statusCode;

    const data =
        response.data || {};

    const text =
        JSON.stringify(data)
            .toLowerCase();


    /*
     * HTTP rate limit.
     */
    if (
        status === 429
    ) {
        return "RATE_LIMIT";
    }


    /*
     * Detect common stock errors.
     */
    const stockIndicators = [

        "out of stock",

        "out_of_stock",

        "no stock",

        "no accounts",

        "no account",

        "sold out",

        "stock empty",

        "unavailable",

        "inventory empty"
    ];


    if (
        stockIndicators.some(
            indicator =>
                text.includes(indicator)
        )
    ) {

        return "NO_STOCK";
    }


    /*
     * Successful response.
     */
    if (
        status >= 200 &&
        status < 300 &&
        data.success === true &&
        data.data
    ) {

        return "SUCCESS";
    }


    /*
     * Explicit API failure.
     */
    if (
        data.success === false
    ) {

        return "API_ERROR";
    }


    /*
     * Other HTTP errors.
     */
    if (
        status >= 400
    ) {

        return "HTTP_ERROR";
    }


    /*
     * Unexpected response.
     */
    return "INVALID_RESPONSE";
}


/* =========================================================
   TEMPORARY FAILURE
========================================================= */

async function handleFailure(
    type,
    reason
) {

    if (
        CONFIG.AUTO_RESTART
    ) {

        if (!STATE.retrying) {

            STATE.retrying = true;

            await operationalLog(
                "WARNING",

                `${displayType(type)} generation encountered ${reason}. Auto-restart is enabled; waiting before retrying.`,

                {
                    Type:
                        displayType(type),

                    RetryAfter:
                        formatDuration(
                            CONFIG.RETRY_DELAY_MS
                        )
                }
            );
        }

        await sleep(
            CONFIG.RETRY_DELAY_MS
        );

        STATE.retrying = false;

        return;
    }


    await stopGenerator(
        `${displayType(type)} generation stopped: ${reason}.`
    );
}


/* =========================================================
   GENERATE ONE
========================================================= */

async function processGenerator(
    type
) {

    const config =
        CONFIG.GENERATORS[type];

    if (!config.enabled) {
        return;
    }


    if (
        hasReachedLimit(type)
    ) {

        await announceDailyLimit(
            type
        );

        return;
    }


    if (
        !cooldownFinished(type)
    ) {
        return;
    }


    if (
        STATE.generationInProgress
    ) {
        return;
    }


    STATE.generationInProgress = true;


    try {

        await operationalLog(
            "INFO",

            `Starting ${displayType(type)} generation.`,

            {
                Type:
                    displayType(type),

                Today:
                    getCount(type),

                Remaining:
                    getRemaining(type)
            }
        );


        const response =
            await generateAccount(
                type
            );


        const result =
            classifyResponse(
                response
            );


        /* ---------------------------------------------
           SUCCESS
        --------------------------------------------- */

        if (
            result === "SUCCESS"
        ) {

            const account =
                response.data.data;


            markGeneration(type);


            let destination;

            try {

                destination =
                    await postAccount(
                        account,
                        type
                    );

            } catch (error) {

                /*
                 * Generation succeeded even if Discord
                 * failed. Keep the counter consumed.
                 */
                await operationalLog(
                    "ERROR",

                    `Account generated, but Discord delivery failed.`,

                    {
                        Type:
                            displayType(type),

                        Error:
                            error.message
                    }
                );

                return;
            }


            await operationalLog(
                "INFO",

                `Generation completed successfully.`,

                {
                    Type:
                        displayType(type),

                    Destination:
                        destination,

                    Today:
                        getCount(type),

                    Remaining:
                        getRemaining(type)
                }
            );


            if (
                hasReachedLimit(type)
            ) {

                await announceDailyLimit(
                    type
                );
            }


            return;
        }


        /* ---------------------------------------------
           RATE LIMIT
        --------------------------------------------- */

        if (
            result === "RATE_LIMIT"
        ) {

            await handleFailure(
                type,
                "a rate limit"
            );

            return;
        }


        /* ---------------------------------------------
           NO STOCK
        --------------------------------------------- */

        if (
            result === "NO_STOCK"
        ) {

            await handleFailure(
                type,
                "no stock being available"
            );

            return;
        }


        /* ---------------------------------------------
           API ERROR
        --------------------------------------------- */

        await operationalLog(
            "ERROR",

            `BloxGen returned an unsuccessful response.`,

            {
                Type:
                    displayType(type),

                HTTP:
                    response.statusCode,

                Response:
                    JSON.stringify(
                        response.data
                    ).slice(0, 1000)
            }
        );


        await handleFailure(
            type,
            "an API error"
        );

    } catch (error) {

        await operationalLog(
            "ERROR",

            `Request failed while generating ${displayType(type)}.`,

            {
                Type:
                    displayType(type),

                Error:
                    error.message
            }
        );


        await handleFailure(
            type,
            "a request failure"
        );

    } finally {

        STATE.generationInProgress =
            false;
    }
}


/* =========================================================
   SCHEDULER
========================================================= */

function getEnabledTypes() {

    return Object.keys(
        CONFIG.GENERATORS
    ).filter(
        type =>
            CONFIG.GENERATORS[type]
                .enabled
    );
}


function getReadyGenerators() {

    return getEnabledTypes()
        .filter(type => {

            if (
                hasReachedLimit(type)
            ) {
                return false;
            }

            if (
                !cooldownFinished(type)
            ) {
                return false;
            }

            return true;
        });
}


async function schedulerTick() {

    if (
        !STATE.running ||
        STATE.stopping
    ) {
        return;
    }


    resetDailyCountersIfNeeded();


    if (
        STATE.generationInProgress
    ) {
        return;
    }


    const ready =
        getReadyGenerators();


    if (
        ready.length === 0
    ) {
        return;
    }


    /*
     * Run the first ready generator.
     *
     * Each generator has its own cooldown and counter,
     * so another type can become ready independently.
     */
    await processGenerator(
        ready[0]
    );
}


/* =========================================================
   START
========================================================= */

async function startGenerator() {

    if (
        STATE.running
    ) {
        return;
    }


    STATE.running = true;

    STATE.stopping = false;


    await operationalLog(
        "INFO",

        "BloxGen Generator started.",

        {
            Enabled:
                getEnabledTypes()
                    .map(displayType)
                    .join(", ") || "None",

            AutoRestart:
                CONFIG.AUTO_RESTART
                    ? "Enabled"
                    : "Disabled"
        }
    );


    /*
     * Immediately check once.
     */
    await schedulerTick();


    /*
     * Continue checking.
     */
    STATE.scheduler =
        setInterval(
            () => {

                schedulerTick()
                    .catch(error => {

                        operationalLog(
                            "ERROR",

                            "Unhandled scheduler error.",

                            {
                                Error:
                                    error.message
                            }
                        );
                    });

            },

            CONFIG.SCHEDULER_INTERVAL_MS
        );
}


/* =========================================================
   STOP
========================================================= */

async function stopGenerator(
    reason = "Generator stopped."
) {

    if (
        STATE.stopping
    ) {
        return;
    }
