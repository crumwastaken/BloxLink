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

    API_KEY: process.env.BLOXGEN_API_KEY,

    WEBHOOKS: {
        MAIN: process.env.DISCORD_MAIN_WEBHOOK,
        UNWANTED: process.env.DISCORD_UNWANTED_WEBHOOK,
        LOGS: process.env.DISCORD_LOG_WEBHOOK
    },

    /*
     * Put the BloxGen logo URL here.
     * This is NOT a secret.
     */
    BLOXGEN_LOGO_URL: "",

    BOT_NAME: "BloxGen Generator",

    /*
     * Generator configuration.
     *
     * Only +30 days is enabled by default.
     */
    GENERATORS: {

        alt: {
            enabled: false,
            dailyLimit: 50,
            cooldownMs: 30 * 1000
        },

        "30day": {
            enabled: true,
            dailyLimit: 15,
            cooldownMs: 60 * 1000
        },

        "1year": {
            enabled: false,
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
            `${CONFIG.BOT_NAME} • ${level}`,

        description:
            String(message)
                .slice(0, 4096),

        color:
            colors[level] ||
            CONFIG.EMBED_COLOR,

        fields,

        footer: {
            text:
                "Operational Log • BloxGen Generator"
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
    account,
    requestedType
) {

    /*
     * BloxGen's documented response includes
     * estimated_age.
     */

    const age =
        Number(account.estimated_age);

    /*
     * If an actual numeric age is available,
     * use it as the source of truth.
     */
    if (
        Number.isFinite(age)
    ) {

        if (age >= 30) {
            return "MAIN";
        }

        return "UNWANTED";
    }

    /*
     * If the age is unavailable, don't guess that
     * an ALT is old enough.
     *
     * For explicitly aged generators, the requested
     * type itself provides a reasonable fallback.
     */
    if (
        requestedType === "30day" ||
        requestedType === "1year" ||
        requestedType === "5year"
    ) {

        return "MAIN";
    }

    /*
     * An unverified ALT with no usable age information
     * goes to the unwanted channel rather than being
     * incorrectly classified as 30+ days.
     */
    return "UNWANTED";
}


/* =========================================================
   ACCOUNT EMBED
========================================================= */

function createAccountEmbed(
    account,
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
                "BloxGen • Automated Generation System"
        },

        timestamp:
            new Date().toISOString()
    };


    /*
     * Avatar headshot.
     */
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


    /*
     * BloxGen logo.
     */
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

function createRawAccountMessage(
    account
) {

    return [
        "```json",
        JSON.stringify(
            account,
            null,
            2
        ),
        "```"
    ].join("\n");
}


/* =========================================================
   POST ACCOUNT
========================================================= */

async function postAccount(
    account,
    requestedType
) {

    const destination =
        routeAccount(
            account,
            requestedType
        );

    const webhook =
        destination === "MAIN"
            ? CONFIG.WEBHOOKS.MAIN
            : CONFIG.WEBHOOKS.UNWANTED;


    /*
     * Raw API response.
     */
    const rawData =
        JSON.stringify(
            account,
            null,
            2
        );


    /*
     * Discord has a 2000 character message-content
     * limit. If the raw JSON is larger, send it as
     * a code block when possible, otherwise truncate
     * it rather than failing the entire generation.
     */
    let content =
        createRawAccountMessage(
            account
        );

    if (content.length > 2000) {

        content =
            [
                "```json",
                rawData.slice(
                    0,
                    1950
                ),
                "```"
            ].join("\n");
    }


    const embed =
        createAccountEmbed(
            account,
            requestedType
        );


    await sendWebhook(
        webhook,

        {
            username:
                CONFIG.BOT_NAME,

            content,

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


    STATE.stopping = true;

    STATE.running = false;


    if (
        STATE.scheduler
    ) {

        clearInterval(
            STATE.scheduler
        );

        STATE.scheduler = null;
    }


    await operationalLog(
        "WARNING",
        reason
    );
}


/* =========================================================
   DURATION FORMAT
========================================================= */

function formatDuration(ms) {

    let seconds =
        Math.ceil(ms / 1000);

    const days =
        Math.floor(
            seconds / 86400
        );

    seconds %= 86400;

    const hours =
        Math.floor(
            seconds / 3600
        );

    seconds %= 3600;

    const minutes =
        Math.floor(
            seconds / 60
        );

    seconds %= 60;


    const parts = [];

    if (days) {
        parts.push(`${days}d`);
    }

    if (hours) {
        parts.push(`${hours}h`);
    }

    if (minutes) {
        parts.push(`${minutes}m`);
    }

    if (seconds) {
        parts.push(`${seconds}s`);
    }


    return parts.length
        ? parts.join(" ")
        : "0s";
}


/* =========================================================
   STATUS DISPLAY
========================================================= */

function printStatus() {

    console.log("");
    console.log(
        "=============================="
    );
    console.log(
        " BloxGen Generator Status"
    );
    console.log(
        "=============================="
    );


    for (
        const [type, config]
        of Object.entries(
            CONFIG.GENERATORS
        )
    ) {

        if (!config.enabled) {
            continue;
        }


        const count =
            getCount(type);


        const remaining =
            getRemaining(type);


        const last =
            STATE.lastGeneration[type];


        let cooldown =
            "Ready";


        if (last) {

            const remainingMs =
                Math.max(
                    0,

                    config.cooldownMs -
                    (
                        Date.now() -
                        last
                    )
                );


            if (
                remainingMs > 0
            ) {

                cooldown =
                    formatDuration(
                        remainingMs
                    );
            }
        }


        console.log(
            `${displayType(type)}: ${count}/${config.dailyLimit} | Cooldown: ${cooldown} | Remaining: ${remaining}`
        );
    }


    console.log(
        "=============================="
    );

    console.log("");
}


/* =========================================================
   PROCESS SIGNALS
========================================================= */

process.on(
    "SIGINT",

    async () => {

        await stopGenerator(
            "Generator stopped manually."
        );

        process.exit(0);
    }
);


process.on(
    "SIGTERM",

    async () => {

        await stopGenerator(
            "Generator terminated."
        );

        process.exit(0);
    }
);


/* =========================================================
   STARTUP
========================================================= */

async function main() {

    validateConfig();

    loadState();

    resetDailyCountersIfNeeded();

    printStatus();

    await startGenerator();
}


main()
    .catch(
        async error => {

            console.error(
                "Fatal error:",
                error
            );

            await operationalLog(
                "ERROR",

                "Fatal generator error.",

                {
                    Error:
                        error.message
                }
            );

            process.exit(1);
        }
    );
