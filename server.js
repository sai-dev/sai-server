require("./classes/prototypes.js");
const moment = require("moment");
const express = require("express");
const fileUpload = require("express-fileupload");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const fs = require("fs-extra");
const MongoClient = require("mongodb").MongoClient;
const Long = require("mongodb").Long;
const ObjectId = require("mongodb").ObjectID;
const zlib = require("zlib");
const Cacheman = require("cacheman");
const app = express();
const Busboy = require("busboy");
const weight_parser = require("./classes/weight_parser.js");
const rss_generator = require("./classes/rss_generator.js");
const os = require("os");
const path = require("path");
const discord = require("./classes/discord");
const morgan = require("morgan");
const rfs = require("rotating-file-stream");
const dbutils = require("./classes/dbutils");
const mongoMorgan = require("mongo-morgan");
const Raven = require("raven");
const config = require("./configsai");
const email_validator = require("email-validator");
const nodemailer = require('nodemailer');

const archiver = require('archiver');
const ini = require('ini');
const SGFParser = require('smartgame');

const configsai = ini.parse(fs.readFileSync(__dirname + "/config.ini", "utf-8"));
const default_visits = configsai.default_visits ? Number(configsai.default_visits) : 1600;
const default_randomcnt = configsai.default_randomcnt ? Number(configsai.default_randomcnt) : 30;
const default_resignation_percent = configsai.default_resignation_percent ? Number(configsai.default_resignation_percent) : 5;
const default_no_resignation_probability = configsai.default_no_resignation_probability ? Number(configsai.default_no_resignation_probability) : 0.1;
const default_komi = configsai.default_komi ? Number(configsai.default_komi) : 7.5;
const default_noise_value = configsai.default_noise_value ?  Number(configsai.default_noise_value) : 0.03;
const default_lambda = configsai.default_lambda ? Number(configsai.default_lambda) : 0.5;
const default_other_options_selfplay = configsai.default_other_options_selfplay ? String(configsai.default_other_options_selfplay): "";
const default_other_options_match = configsai.default_other_options_match ? String(configsai.default_other_options_match): "";
const disable_default_selfplay = Boolean(configsai.disable_default_selfplay);
const base_port = configsai.base_port ? Number(configsai.base_port) :  8080;
const instance_number = configsai.instance_number ? Number(configsai.instance_number) : 0;
const schedule_matches_to_all = configsai.schedule_matches_to_all ? Boolean(configsai.schedule_matches_to_all) : false;
const no_early_fail = configsai.no_early_fail ?  Boolean(configsai.no_early_fail) : false;
const branching_coefficient = configsai.branching_coefficient ? Number(configsai.branching_coefficient) : 0.1;
const branching_maxbranches = configsai.branching_maxbranches ? Number(configsai.branching_maxbranches) : 3;

const MONGODB_URL = configsai.mongodb_url ? configsai.mongodb_url : "mongodb://localhost/sai"+instance_number;

const LZGRAPHSCALE = 4
const GRAPHRECENT = 900000

if (config.RAVEN_DSN) {
    console.log("init raven");
    Raven.config(config.RAVEN_DSN, { captureUnhandledRejections: true }).install();
}

/**
 * Request Logging
 */
const logDir = path.join(__dirname, "logs");
fs.ensureDirSync(logDir);
const logStream = rfs("access.log", {
    interval: "1d", // rotate daily
    maxFiles: 7, // keep 1 week worth of logs
    path: logDir
});
morgan.token("memory", () => {
    const used = process.memoryUsage();
    const usage = [];

    for (const key in used) {
        const size = (used[key] / 1024 / 1024).toFixed(2);

        usage.push(`${key}: ${size} MB`);
    }

    return usage.join(", ");
});
mongoMorgan.token("epochtime", () => Date.now());

// Save access log to `logs` collection
app.use(
    mongoMorgan(
        MONGODB_URL,
        "{\"method\": \":method\", \"url\": \":url\", \"status\": :status, \"response-time\": :response-time, \"time\": :epochtime}",
        { collection: "logs" })
    );

app.use(morgan("-->Before :memory", { stream: logStream, immediate: true }));
app.use(morgan(":method :url :status :req[content-length] :response-time ms", { stream: logStream, immediate: false }));
app.use(morgan("-->After  :memory", { stream: logStream, immediate: false }));

/**
 * Utilities
 */
const {
    set_task_verification_secret,
    add_match_verification,
    check_match_verification,
    network_exists,
    checksum,
    make_seed,
    get_timestamp_from_seed,
    seed_from_mongolong,
    process_games_list,
    CalculateEloFromPercent,
    objectIdFromDate,
    log_memory_stats,
    SPRT,
    LLR,
    asyncMiddleware,
    how_many_games_to_queue,
    add_gzip_hash
} = require("./classes/utilities.js");

const ELF_NETWORKS = [
    "62b5417b64c46976795d10a6741801f15f857e5029681a42d02c9852097df4b9",
    "d13c40993740cb77d85c838b82c08cc9c3f0fbc7d8c3761366e5d59e8f371cbd"
];

const auth_key = String(fs.readFileSync(__dirname + "/auth_key")).trim();
const public_auth_key = String(fs.readFileSync(__dirname + "/public_auth_key")).trim();
set_task_verification_secret(String(fs.readFileSync(__dirname + "/task_secret")).trim());

const cacheIP24hr = new Cacheman("IP24hr");
const cacheIP1hr = new Cacheman("IP1hr");

// Cache information about matches and best network rating
const cachematches = new Cacheman("matches");
const cacheratings = new Cacheman("ratings");
const cacheleaders = new Cacheman("leaders");
let bestRatings = new Map();

const fastClientsMap = new Map();

app.set("view engine", "pug");

// This shouldn't be needed but now and then when I restart test server, I see an uncaught ECONNRESET and I'm not sure
// where it is coming from. In case a server restart did the same thing, this should prevent a crash that would stop nodemon.
//
// It was a bug in nodemon which has now been fixed. It is bad practice to leave this here, eventually remove it.
//
process.on("uncaughtException", err => {
    console.error("Caught exception: " + err);
});

// https://blog.tompawlak.org/measure-execution-time-nodejs-javascript

let counter = 0;
let elf_counter = 0;
let best_network_mtimeMs = 0;
let best_network_hash_promise = null;
let db;

// TODO Make a map to store pending match info, use mapReduce to find who to serve out, only
// delete when SPRT fail or needed games have all arrived? Then we can update stats easily on
// all matches except just the current one (end of queue).
//
let pending_matches = [];
const MATCH_EXPIRE_TIME = 30 * 60 * 1000; // matches expire after 30 minutes. After that the match will be lost and an extra request will be made.

// Similar data for requested selfplays
let pending_selfplays = [];
const SELFPLAY_EXPIRE_TIME = 30 * 60 * 1000; // selfplays expire after 30 minutes. After that the selfplay will be lost and an extra request will be made.

const current_users = new Map();

function analyze_sgf_comments (comment) {
    [alpkt, alpkt0, beta, pi, avg_eval, avg_bonus, is_blunder] = comment.split(",").map(parseFloat);
//    return  { priority: branching_coefficient*(0.25-avg_eval*(1-avg_eval)), komi: Math.round(alpkt) };
    if (alpkt == 0.0 && beta == 1.0) return { priority: 0.0, komi: 0 };
    return  { priority: branching_coefficient*0.25, komi: Math.round(alpkt) };
}

function analyze_sgf(sgf) {
    const nodes = SGFParser.parse(sgf).gameTrees[0].nodes;
    const result = [ ];
    for (const pos in nodes) {
        if (pos == 0) continue;
        const value = analyze_sgf_comments(nodes[pos].C);
        result.unshift({ move: Number(pos), rawvalues: nodes[pos].C, priority: value.priority, komi: value.komi });
    }
    result.sort( (a,b) => b.priority - a.priority );
    return result;
}

function generate_branches(sgf) {
    const nodes = SGFParser.parse(sgf).gameTrees[0].nodes;
    const result = [ ];
    for (const pos in nodes) {
        if (result.length >= branching_maxbranches) break;
        if (pos == 0) continue;
        const value = analyze_sgf_comments(nodes[pos].C);
        if (Math.random() <= value.priority) {
            result.unshift({ move: Number(pos), priority: value.priority, komi: value.komi });
        }
    }
    return result;
}

function get_options_hash(options) {
    if (options.visits) {
        return checksum("" + options.visits + options.resignation_percent + options.noise + options.randomcnt + options.komi + options.noise_value + options.lambda + options.dumbpass + options.other_options).slice(0, 6);
    } else {
        return checksum("" + options.playouts + options.resignation_percent + options.noise + options.randomcnt + options.komi + options.noise_value + options.lambda + options.dumbpass + options.other_options).slice(0, 6);
    }
}

async function get_fast_clients() {
    const start = Date.now();
    try {
        // Get some recent self-play games to calculate durations from seeds
        const games = await db.collection("games").find({}, { ip: 1, movescount: 1, random_seed: 1 })
            .sort({ _id: -1 }).limit(1000).toArray();

        // Keep track of the move rate of each game by client
        fastClientsMap.clear();
        games.forEach(game => {
            const seed = (s => s instanceof Long ? s : new Long(s))(game.random_seed);
            const startTime = get_timestamp_from_seed(seed);
            const minutes = (game._id.getTimestamp() / 1000 - startTime) / 60;

            // Make sure we have some reasonable duration
            if (minutes > 0 && minutes <= 60 * 24)
                fastClientsMap.set(game.ip, [...(fastClientsMap.get(game.ip) || []), game.movescount / minutes]);
        });

        // Clean up the map to be a single rate value with enough entries
        for (const [ip, rates] of fastClientsMap) {
            // Remove clients that submitted only a couple fast games (in case
            // some unexpected seed just happens to match the duration)
            if (rates.length < 3)
                fastClientsMap.delete(ip);
            else
                fastClientsMap.set(ip, rates.reduce((t, v) => t + v) / rates.length);
        }

        // Short circuit if there's nothing interesting to do
        if (fastClientsMap.size == 0) {
            console.log("No clients found with sufficient rate data");
            return;
        }

        // Print out some statistics on rates
        const sortedRates = [...fastClientsMap.values()].sort((a, b) => a - b);
        const quartile = n => {
            const index = n / 4 * (sortedRates.length - 1);
            return index % 1 == 0 ? sortedRates[index] : (sortedRates[Math.floor(index)] + sortedRates[Math.ceil(index)]) / 2;
        };
        console.log("Client moves per minute rates:", ["min", "25%", "median", "75%", "max"].map((text, index) => `${quartile(index).toFixed(1)} ${text}`).join(", "));

        // Keep only clients that have the top 25% rates
        const top25Rate = quartile(2);
        for (const [ip, rate] of fastClientsMap) {
            if (rate < top25Rate)
                fastClientsMap.delete(ip);
        }

        console.log(`In ${Date.now() - start}ms from recent ${games.length} games, found ${fastClientsMap.size} fast clients:`, fastClientsMap);
    } catch (err) {
        console.log("Failed to get recent games for fast clients:", err);
    }
}

//  db.matches.aggregate( [ { "$redact": { "$cond": [ { "$gt": [ "$number_to_play", "$game_count" ] }, "$$KEEP", "$$PRUNE" ] } } ] )
//
async function get_pending_matches() {
    pending_matches = [];

    return new Promise((resolve, reject) => {
        db.collection("matches").aggregate([
            { $redact: { $cond:
                [
                    { $gt: [ "$number_to_play", "$game_count" ] },
                    "$$KEEP", "$$PRUNE"
                ] } }
        ]).sort({ _id: -1 }).forEach(match => {
            match.requests = []; // init request list.

            // Client only accepts strings for now
            //
            Object.keys(match.options).map(key => {
                match.options[key] = String(match.options[key]);
            });

            // If SPRT=pass use unshift() instead of push() so "Elo only" matches go last in priority
            //
            switch (SPRT(match.network1_wins, match.network1_losses)) {
                case false:
                    if (no_early_fail) {
                        pending_matches.unshift( match );
                        console.log("SPRT fail: Unshifting: " + JSON.stringify(match));
                    }
                    break;
                case true:
                    pending_matches.unshift(match);
                    console.log("SPRT success: Unshifting: " + JSON.stringify(match));
                    break;
                default:
                    pending_matches.push(match);
                    console.log("SPRT: Pushing: " + JSON.stringify(match));
            }
        }, err => {
            if (err) {
                console.error("Error fetching matches: " + err);
                return reject(err);
            }
        });
        resolve();
    });
}

//  db.self_plays.aggregate( [ { "$redact": { "$cond": [ { "$gt": [ "$number_to_play", "$game_count" ] }, "$$KEEP", "$$PRUNE" ] } } ] )
//
async function get_pending_selfplays() {
    const best_network_hash = await get_best_network_hash();
    pending_selfplays = [];

    return new Promise( (resolve, reject) => {
        db.collection("self_plays").aggregate( [
            { "$redact": { "$cond":
                [
                    { "$and" : [
                        { "$gt": [ "$number_to_play", "$game_count" ] },
                        { "$eq": [ "$networkhash", best_network_hash ]}
                    ]},
                    "$$KEEP", "$$PRUNE"
                ] } }
        ] ).sort({_id:-1}).forEach( (selfplay) => {
            selfplay.requests = []; // init request list.
            pending_selfplays.unshift(selfplay);
        }, (err) => {
            if (err) {
                console.error("Error fetching selfplays: " + err);
                return reject(err);
            }
        });
        resolve();
    });
};

async function get_best_network_hash() {
    // Check if file has changed. If not, send cached version instead.
    //
    return fs.stat(__dirname + "/network/best-network.gz")
    .then(stats => {
        if (!best_network_hash_promise || best_network_mtimeMs != stats.mtimeMs) {
            best_network_mtimeMs = stats.mtimeMs;

            best_network_hash_promise = new Promise((resolve, reject) => {
                log_memory_stats("best_network_hash_promise begins");

                const rstream = fs.createReadStream(__dirname + "/network/best-network.gz");
                const gunzip = zlib.createGunzip();
                const hash = crypto.createHash("sha256");

                hash.setEncoding("hex");

                log_memory_stats("Streams prepared");

                rstream
                .pipe(gunzip)
                .pipe(hash)
                .on("error", err => {
                    console.error("Error opening/gunzip/hash best-network.gz: " + err);
                    reject(err);
                })
                .on("finish", () => {
                    const best_network_hash = hash.read();
                    log_memory_stats("Streams completed: " + best_network_hash);
                    resolve(best_network_hash);
                });
            });
        }

        return best_network_hash_promise;
    })
    .catch(err => console.error(err));
}

async function get_current_users() {
    current_users.clear();
    const users = await db.collection("users").find({ active: true }, { username: 1, password: 1 }).toArray();
    users.forEach( (user) => current_users.set(user.username, user.password) );
}

function validate_user(username, password, key) {
    if (key && public_auth_key != "" && key == public_auth_key)
        return "";
    if (username && password && current_users.get(username) == password)
        return username;
    return false;
}

const PESSIMISTIC_RATE = 0.4;

app.enable("trust proxy");

app.use(bodyParser.urlencoded({ extended: true }));
app.use(/\/((?!submit-network).)*/, fileUpload());

app.use("/view/player", express.static("static/eidogo-player-1.2/player"));
app.use("/viewmatch/player", express.static("static/eidogo-player-1.2/player"));
app.use("/view/wgo", express.static("static/wgo"));
app.use("/viewmatch/wgo", express.static("static/wgo"));
app.use("/static", express.static("static", { maxage: "365d", etag: true }));
app.use('/networks',express.static('network'));

// This is async but we don't need it to start the server. I'm calling it during startup so it'll get the value cached right away
// instead of when the first /best-network request comes in, in case a lot of those requests come in at once when server
// starts up.
get_best_network_hash().then(hash => console.log("Current best hash " + hash));

setInterval(() => {
    log_memory_stats("10 minute interval");

    get_fast_clients()
    .then()
    .catch();
}, 1000 * 60 * 10);

let last_match_db_check = Date.now();

setInterval(() => {
    const now = Date.now();

    // In case we have no matches scheduled, we check the db.
    //
    if (pending_matches.length === 0 && now > last_match_db_check + 30 * 60 * 1000) {
        console.log("No matches scheduled. Updating pending list.");

        last_match_db_check = now;

        get_pending_matches()
        .then()
        .catch();
    }
}, 1000 * 60 * 1);

let last_selfplay_db_check = Date.now();

setInterval( () => {
    const now = Date.now();

    // In case we have no selfplays scheduled, we check the db.
    //
    if (pending_selfplays.length === 0 && now > last_selfplay_db_check + 30 * 60 * 1000) {
        console.log("No self-plays scheduled. Updating pending list.");

        last_selfplay_db_check = now;

        get_pending_selfplays()
        .then()
        .catch();
    }
}, 1000 * 60 * 1);

MongoClient.connect(MONGODB_URL, (err, database) => {
    if (err) return console.log(err);

    db = database;

    db.collection("networks").count()
    .then(count => {
        console.log(count + " networks.");
    });

    db.collection("networks").aggregate([
        {
            $group: {
                _id: {
                    type: {
                        $cond: {
                            if: { $in: ["$hash", ELF_NETWORKS] },
                            then: "ELF",
                            else: "LZ"
                        }
                    }
                },
                total: { $sum: "$game_count" }
            }
        }
    ], (err, res) => {
        if (err) console.log(err);

        get_fast_clients()
        .then()
        .catch();

        get_pending_matches()
        .then()
        .catch();

        get_pending_selfplays()
        .then()
        .catch();

        get_current_users()
        .then()
        .catch();

        res.forEach(result => {
            if (result._id.type == "ELF")
                elf_counter = result.total;
            else
                counter = result.total;
        });
        console.log(counter + " LZ games, " + elf_counter + " ELF games.");

        app.listen(base_port+instance_number, () => {
            console.log('listening on '+String(base_port+instance_number))
        });

        // Listening to both ports while /next people are moving over to real server adddress
        //
        // app.listen(8081, () => {
        //    console.log('listening on 8081')
        // });
    });
});

// Obsolete
//
app.use("/best-network-hash", asyncMiddleware(async(req, res) => {
    const hash = await get_best_network_hash();

    res.write(hash);
    res.write("\n");
    // Can remove if autogtp no longer reads this. Required client and leelza versions are in get-task now.
    res.write("11");
    res.end();
}));

// Server will promote a network.
//
app.post('/promote',asyncMiddleware( async (req, res, next) => {
    if (!req.body.key || req.body.key != auth_key) {
        console.log("AUTH FAIL: '" + String(req.body.key) + "' VS '" + String(auth_key) + "'");

        return res.status(400).send('Incorrect key provided.');
    }

    if (!req.body.hash)
        return res.status(400).send('Network hash not provided.');
    fs.copyFileSync(__dirname + '/network/' + req.body.hash + '.gz', __dirname + '/network/best-network.gz');
    await get_pending_selfplays();
    res.send("Network has been promoted");
}));

// Server will copy a new best-network to the proper location if validation testing of an uploaded network shows
// it is stronger than the prior network. So we don't need to worry about locking the file/etc when uploading to
// avoid an accidential download of a partial upload.
//
// This is no longer used, as /network/ is served by nginx and best-network.gz downloaded directly from it
//
app.use("/best-network", asyncMiddleware(async(req, res) => {
    const hash = await get_best_network_hash();
    const readStream = fs.createReadStream(__dirname + "/network/best-network.gz");

    readStream.on("error", err => {
        res.send("Error: " + err);
        console.error("ERROR /best-network : " + err);
    });

    readStream.on("open", () => {
        res.setHeader("Content-Disposition", "attachment; filename=" + hash + ".gz");
        res.setHeader("Content-Transfer-Encoding", "binary");
        res.setHeader("Content-Type", "application/octet-stream");
    });

    readStream.pipe(res);

    console.log(req.ip + " (" + req.headers["x-real-ip"] + ") " + " downloaded /best-network");
}));

app.post('/best-network-chunks', asyncMiddleware( async (req, res, next) => {
    if (!req.body.key || req.body.key != auth_key) {
        console.log("AUTH FAIL: '" + String(req.body.key) + "' VS '" + String(auth_key) + "'");

        return res.status(400).send('Incorrect key provided.');
    }

    let game_count = 0;
    let chunk_count = 0;
    let chunk = "";
    const hash = req.body.hash || await get_best_network_hash();

    function write_chunk() {
        const filename = "train_" + hash.substring(0,8) + "_" + chunk_count + ".gz";
        console.log("New  " + filename + " Chunk " + chunk_count+ " written");
        zip.append(zlib.gzipSync(chunk), { name: filename });
        game_count = 0;
        chunk_count += 1;
        chunk = "";
    }

    res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-disposition': 'attachment; filename=chunks.zip'
    });
    const zip = archiver('zip')
    zip.pipe(res);
    db.collection("games").find( { networkhash: hash }, { _id: false, data: true } )
    .limit(275000)
    .forEach((match) => {
        chunk += match.data;
        game_count += 1;
        if (game_count >= 64)
            write_chunk();
    }, (err) => {
        if (err)
            return res("Error fetching games: " + err);
        else
            if (game_count > 0)
                write_chunk();
            zip.finalize();
    });
}));

app.post('/request-match', (req, res) => {
    // "number_to_play" : 400, "options" : { "playouts" : 1600, "resignation_percent" : 1, "randomcnt" : 0, "noise" : "false" }

    if (!req.body.key || req.body.key != auth_key) {
        console.log("AUTH FAIL: '" + String(req.body.key) + "' VS '" + String(auth_key) + "'");

        return res.status(400).send("Incorrect key provided.");
    }

    if (!req.body.network1)
        return res.status(400).send("No network1 hash specified.");
    else if (!network_exists(req.body.network1))
        return res.status(400).send("network1 hash not found.");

    if (!req.body.network2)
        req.body.network2 = null;
    else if (!network_exists(req.body.network2))
        return res.status(400).send("network2 hash not found.");

    if (!req.body.type)
        req.body.type = null;

    if (!req.body.rem)
        req.body.rem = null;

    // TODO Need to support new --visits flag as an alternative to --playouts. Use visits if both are missing? Don't allow both to be set.
    //
    if (req.body.playouts && req.body.visits)
        return res.status(400).send("Please set only playouts or visits, not both");

    if (!req.body.playouts && !req.body.visits)
        //req.body.playouts = 1600;
        req.body.visits = default_visits;
        //return res.status(400).send('No playouts specified.');

    if (!req.body.resignation_percent)
        req.body.resignation_percent = default_resignation_percent;
        //return res.status(400).send('No resignation_percent specified.');

    if (!req.body.noise)
        req.body.noise = false;
        //return res.status(400).send('No noise specified.');

    if (!req.body.randomcnt)
        req.body.randomcnt = 0;
        //return res.status(400).send('No randomcnt specified.');

    if (!req.body.number_to_play)
        req.body.number_to_play = 400;
        //return res.status(400).send('No number_to_play specified.');

    if (!req.body.komi)
        req.body.komi = default_komi;

    if (!req.body.lambda)
        req.body.lambda = default_lambda;

    if (!req.body.dumbpass)
        req.body.dumbpass = String(config.default_dumbpass);

    if (! ('other_options' in req.body))
        req.body.other_options = default_other_options_match;

    const options = { resignation_percent: Number(req.body.resignation_percent),
        randomcnt: Number(req.body.randomcnt),
        noise: String(req.body.noise),
        komi: Number(req.body.komi),
        lambda: Number(req.body.lambda),
        dumbpass: req.body.dumbpass.toLowerCase() === "true",
        other_options: String(req.body.other_options)};

    if (req.body.playouts) {
        options.playouts = Number(req.body.playouts);
    }

    if (req.body.visits) {
        options.visits = Number(req.body.visits);
    }

    // Usage:
    //   - schedule a Test match, set is_test=true or is_test=1
    //   curl -F is_test=true <other params>
    //
    //   - schedule a Normal match, leave out the flag
    //   curl  <other params>
    //
    req.body.is_test = ["true", "1"].includes(req.body.is_test);

    const match = { network1: req.body.network1,
        network2: req.body.network2, network1_losses: 0,
        network1_wins: 0,
        game_count: 0, number_to_play: Number(req.body.number_to_play),
        is_test: req.body.is_test,
        type: req.body.type,
        rem: req.body.rem,
        options, options_hash: get_options_hash(options) };

    db.collection("matches").insertOne(match)
    .then(() => {
        // Update cache
        dbutils.clear_matches_cache();

        // Client only accepts strings for now
        Object.keys(match.options).map(key => {
            match.options[key] = String(match.options[key]);
        });

        match.requests = []; // init request list.
        pending_matches.unshift(match);

        console.log(req.ip + " (" + req.headers["x-real-ip"] + ") " + " Match added!");
        res.send((match.is_test ? "Test" : "Regular") + " Match added!\n");
        console.log("Pending is now: " + JSON.stringify(pending_matches));
    })
    .catch(err => {
        console.error(req.ip + " (" + req.headers["x-real-ip"] + ") " + " ERROR: Match addition failed: " + err);
        res.send("ERROR: Match addition failed\n");
    });
});

// curl -F 'weights=@zero.prototxt' -F 'training_count=175000' http://localhost:8080/submit-network
//
// Detect if network already exists and if so, inform the uploader and don't overwrite?
// So we don't think the network is newer than it really is. Actually, upsert shouldn't change
// the ObjectID so date will remain original insertion date.
//
app.post("/submit-network", asyncMiddleware((req, res) => {
    log_memory_stats("submit network start");
    const busboy = new Busboy({ headers: req.headers });

    req.body = {};

    let file_promise = null;

    req.pipe(busboy).on("field", (name, value) => {
        req.body[name] = value;
    }).on("file", (name, file_stream, file_name) => {
        if (!req.files)
            req.files = {};

        if (name != "weights") {
            // Not the file we expected, flush the stream and do nothing
            //
            file_stream.on("readable", file_stream.read);
            return;
        }

        const temp_file = path.join(os.tmpdir(), file_name);
        // Pipes
        //   - file_stream.pipe(fs_stream)
        //   - file_stream.pipe(gunzip_stream)
        //       - gunzip_stream.pipe(hasher)
        //       - gunzip_stream.pipe(parser)
        file_promise = new Promise((resolve, reject) => {
            const fs_stream = file_stream.pipe(fs.createWriteStream(temp_file)).on("error", reject);
            const gunzip_stream = file_stream.pipe(zlib.createGunzip()).on("error", reject);

            Promise.all([
                new Promise(resolve => {
                    fs_stream.on("finish", () => resolve({ path: fs_stream.path }));
                }),
                new Promise(resolve => {
                    const hasher = gunzip_stream.pipe(crypto.createHash("sha256")).on("finish", () => resolve({ hash: hasher.read().toString("hex") }));
                }),
                new Promise(resolve => {
                    const parser = gunzip_stream.pipe(new weight_parser()).on("finish", () => resolve(parser.read()));
                })
            ]).then(results => {
                // consolidate results
                results = req.files[name] = Object.assign.apply(null, results);

                // Move temp file to network folder with hash name
                results.path = path.join(__dirname, "network", results.hash + ".gz");
                if (fs.existsSync(temp_file))
                    fs.moveSync(temp_file, results.path, { overwrite: true });

                // We are all done (hash, parse and save file)
                resolve();
            });
        }).catch(err => {
            console.error(err);
            req.files[name] = { error: err };

            // Clean up, flush stream and delete temp file
            file_stream.on("readable", file_stream.read);

            if (fs.existsSync(temp_file))
                fs.removeSync(temp_file);
        });
    }).on("finish", async() => {
        await file_promise;

        if (!req.body.key || req.body.key != auth_key) {
            console.log("AUTH FAIL: '" + String(req.body.key) + "' VS '" + String(auth_key) + "'");
            return res.status(400).send("Incorrect key provided.");
        }

        if (!req.files || !req.files.weights)
            return res.status(400).send("No weights file was uploaded.");

        if (req.files.weights.error)
            return res.status(400).send(req.files.weights.error.message);

        const set = {
            hash: req.files.weights.hash,
            ip: req.ip,
            training_count: +req.body.training_count || null,
            training_steps: +req.body.training_steps || null,
            filters: +req.body.filters || req.files.weights.filters,
            blocks: +req.body.blocks || req.files.weights.blocks,
            training_run: +req.body.training_run || null,
            generation: +req.body.generation || null,
            parent_hash: req.body.parent_hash,
            description: req.body.description
        };

        // No training count given, we'll calculate it from database.
        //
        if (!set.training_count) {
            const cursor = db.collection("networks").aggregate([{ $group: { _id: 1, count: { $sum: "$game_count" } } }]);
            const totalgames = await cursor.next();
            set.training_count = (totalgames ? totalgames.count : 0);
        }

        // Prepare variables for printing messages
        //
        const { blocks, filters, hash, training_count } = set;

        db.collection("networks").updateOne(
            { hash: set.hash },
            { $set: set },
            { upsert: true },
            (err, dbres) => {
                if (err) {
                    res.end(err.message);
                    console.error(err);
                } else {
                    const msg = "Network weights (" + blocks + " x " + filters + ") " + hash + " (" + training_count + ") " + (dbres.upsertedCount == 0 ? "exists" : "uploaded") + "!";
                    res.end(msg);
                    console.log(msg);
                    log_memory_stats("submit network ends");
                }
            }
        );
    });
}));

app.post("/submit-match", asyncMiddleware(async(req, res) => {
    const logAndFail = msg => {
        console.log(`${req.ip} (${req.headers["x-real-ip"]})/submit-match: ${msg}`);
        console.log(`files: ${JSON.stringify(Object.keys(req.files || {}))}, body: ${JSON.stringify(req.body)}`);
        return res.status(400).send(msg);
    };

    const username = validate_user(req.body.username, req.body.password, req.body.key);

    if (username === false)
        return logAndFail("Invalid authentication.");

    if (!req.files)
        return logAndFail("No files were uploaded.");

    if (!req.files.sgf)
        return logAndFail("No sgf file provided.");

    if (!req.body.clientversion)
        return logAndFail("No clientversion provided.");

    if (!req.body.winnerhash)
        return logAndFail("No winner hash provided.");

    if (!req.body.loserhash)
        return logAndFail("No loser hash provided.");

    if (!req.body.winnercolor)
        return logAndFail("No winnercolor provided.");

    if (!req.body.movescount)
        return logAndFail("No movescount provided.");

    if (!req.body.score)
        return logAndFail("No score provided.");

    if (!req.body.options_hash)
        return logAndFail("No options_hash provided.");

    if (!req.body.random_seed)
        return logAndFail("No random_seed provided.");

    if (!check_match_verification(req.body))
        return logAndFail("Verification failed.");

    // Convert random_seed to Long, which is signed, after verifying the string
    req.body.random_seed = Long.fromString(req.body.random_seed, 10);
    req.body.task_time = get_timestamp_from_seed(req.body.random_seed);

    // verify match exists in database
    let match = await db.collection("matches").findOne(
        {
            $or: [
                { network1: req.body.winnerhash, network2: req.body.loserhash },
                { network2: req.body.winnerhash, network1: req.body.loserhash }
            ],
            options_hash: req.body.options_hash
        }
    );

    // Match not found, abort!!
    if (!match)
        return logAndFail("Match not found.");

    // Verify random_seed for the match hasn't been used
    if (await db.collection("match_games").findOne(
        {
            random_seed: req.body.random_seed,
            $or: [
                { winnerhash: req.body.winnerhash, loserhash: req.body.loserhash },
                { loserhash: req.body.winnerhash, winnerhash: req.body.loserhash }
            ],
            options_hash: req.body.options_hash
        }
    ))
        return logAndFail("Upload match with duplicate random_seed.");

    // calculate sgfhash
    try {
        const sgfbuffer = await new Promise((resolve, reject) => zlib.unzip(req.files.sgf.data, (err, res) => {
            if (err) {
                reject(err);
            } else {
                resolve(res);
            }
        }));
        const sgfhash = checksum(sgfbuffer, "sha256");

        // upload match game to database
        const dbres = await db.collection("match_games").updateOne(
            { sgfhash },
            {
                $set: {
                    ip: req.ip, winnerhash: req.body.winnerhash, loserhash: req.body.loserhash, sgf: sgfbuffer.toString(),
                    options_hash: req.body.options_hash,
                    clientversion: Number(req.body.clientversion), winnercolor: req.body.winnercolor,
                    movescount: (req.body.movescount ? Number(req.body.movescount) : null),
                    score: req.body.score,
                    random_seed: req.body.random_seed,
                    username: username
                }
            },
            { upsert: true }
        );

        // Not inserted, we got duplicate sgfhash, abort!
        if (!dbres.upsertedId)
            return logAndFail("Upload match with duplicate sgf.");

        console.log(`${req.ip} (${req.headers["x-real-ip"]}) uploaded in ${Math.round(Date.now() / 1000 - req.body.task_time)}s match: ${sgfhash}`);
        res.send("Match data " + sgfhash + " stored in database\n");
    } catch (err) {
        console.error(err);
        return logAndFail("Error with sgf.");
    }

    // prepare $inc
    const $inc = { game_count: 1 };
    const winner_net = req.body.winnercolor == "jigo" ? 0 : ( (match.network1 == req.body.winnerhash) ? 1 : 2 );
    if (winner_net == 1)
        $inc.network1_wins = 1;
    else if (winner_net == 2)
        $inc.network1_losses = 1;

    // save to database using $inc and get modified document
    match = (await db.collection("matches").findOneAndUpdate(
        { _id: match._id },
        { $inc },
        { returnOriginal: false } // return modified document
    )).value;

    // get latest SPRT result
    const sprt_result = SPRT(match.network1_wins, match.network1_losses);
    const pending_match_index = pending_matches.findIndex(m => m._id.equals(match._id));

    // match is found in pending_matches
    if (pending_match_index >= 0) {
        const m = pending_matches[pending_match_index];

        if (sprt_result === false && ! no_early_fail) {
            // remove from pending matches
            console.log("SPRT: Early fail pop: " + JSON.stringify(m));
            pending_matches.splice(pending_match_index, 1);
            console.log("SPRT: Early fail post-pop: " + JSON.stringify(pending_matches));
        } else {
            // remove the match from the requests array.
            const index = m.requests.findIndex(e => e.seed === seed_from_mongolong(req.body.random_seed));
            if (index !== -1) {
                m.requests.splice(index, 1);
            }

            // update stats
            m.game_count++;
            if (m.network1 == req.body.winnerhash) {
                m.network1_wins++;
            } else {
                m.network1_losses++;
            }

            // Check > 1 since we'll run to 400 even on a SPRT pass, but will do it at end.
            //
            if ( (sprt_result === true || sprt_result === false) && pending_matches.length > 1) {
                console.log("SPRT: Early pass unshift: " + JSON.stringify(m));
                pending_matches.splice(pending_match_index, 1); // cut out the match
                if (m.game_count < m.number_to_play) pending_matches.unshift(m); // continue a SPRT pass at end of queue
                console.log("SPRT: Early pass post-unshift: " + JSON.stringify(pending_matches));
            }
        }
    }

    // Lastly, promotion check!!
    const best_network_hash = await get_best_network_hash();
    if (
        // Best network was being challenged
        match.network2 == best_network_hash
        // This is not a test match
        && !match.is_test
        // SPRT passed OR it has reach 55% after 400 games (stick to the magic number)
        && (
            sprt_result === true
            // || (match.game_count >= 400 && match.network1_wins / match.game_count >= 0.55)
            || (match.game_count >= 100 && match.network1_wins >= match.game_count/2 + Math.sqrt(match.game_count))
        )) {
        const promote_hash = match.network1;
        const promote_file = `${__dirname}/network/${promote_hash}.gz`;
        fs.copyFileSync(promote_file, __dirname + "/network/best-network.gz");
        console.log(`New best network copied from ${promote_file}`);
        discord.network_promotion_notify(promote_hash);
    }

    dbutils.update_matches_stats_cache(db, match._id, winner_net);
    cachematches.clear(() => console.log("Cleared match cache."));
}));

// curl -F 'networkhash=abc123' -F 'file=@zero.prototxt' http://localhost:8080/submit
// curl -F 'networkhash=abc123' -F 'sgf=@zero.prototxt' -F 'trainingdata=@zero.prototxt' http://localhost:8080/submit

app.post("/submit", (req, res) => {
    const logAndFail = msg => {
        console.log(`${req.ip} (${req.headers["x-real-ip"]}) /submit: ${msg}`);
        console.log(`files: ${JSON.stringify(Object.keys(req.files || {}))}, body: ${JSON.stringify(req.body)}`);
        return res.status(400).send(msg);
    };

    const username = validate_user(req.body.username, req.body.password, req.body.key);

    if (username === false)
        return logAndFail("Invalid authentication.");

    if (!req.files)
        return logAndFail("No files were uploaded.");

    if (!req.files.sgf)
        return logAndFail("No sgf file provided.");

    if (!req.files.trainingdata)
        return logAndFail("No trainingdata file provided.");

    if (!req.body.clientversion)
        return logAndFail("No clientversion provided.");

    if (!req.body.networkhash)
        return logAndFail("No network hash provided.");

    if (!req.body.winnercolor)
        return logAndFail("No winnercolor provided.");

    if (!req.body.movescount)
        return logAndFail("No movescount provided.");

    if (!req.body.options_hash)
        return logAndFail("No options_hash provided.");

    if (!req.body.random_seed)
        return logAndFail("No random_seed provided.");

    req.body.random_seed = Long.fromString(req.body.random_seed, 10);
    req.body.task_time = get_timestamp_from_seed(req.body.random_seed);

    const clientversion = req.body.clientversion;
    const networkhash = req.body.networkhash;
    let trainingdatafile;
    let sgffile;
    let sgfhash;

    const sgfbuffer = Buffer.from(req.files.sgf.data);
    const trainbuffer = Buffer.from(req.files.trainingdata.data);

    if (req.ip == "xxx") {
        res.send("Game data " + sgfhash + " stored in database\n");
        console.log("FAKE/SPAM reply sent to " + "xxx" + " (" + req.headers["x-real-ip"] + ")");
    } else {
    zlib.unzip(sgfbuffer, (err, sgfbuffer) => {
        if (err) {
            console.error(err);
            return logAndFail("Error with sgf.");
        } else {
            sgffile = sgfbuffer.toString();
            sgfhash = checksum(sgffile, "sha256");

            zlib.unzip(trainbuffer, (err, trainbuffer) => {
                if (err) {
                    console.error(err);
                    return logAndFail("Error with trainingdata.");
                } else {
                    trainingdatafile = trainbuffer.toString();

                    db.collection("games").updateOne(
                        { sgfhash },
                        { $set: { ip: req.ip, networkhash, sgf: sgffile, options_hash: req.body.options_hash,
                                  movescount: (req.body.movescount ? Number(req.body.movescount) : null),
                                  options: (req.body.options ? JSON.parse(req.body.options) : null),
                                  data: trainingdatafile, clientversion: Number(clientversion),
                                  winnercolor: req.body.winnercolor, random_seed: req.body.random_seed,
                                  selfplay_id: req.body.selfplay_id, username: username } },
                        { upsert: true },
                        err => {
                            // Need to catch this better perhaps? Although an error here really is totally unexpected/critical.
                            //
                            if (err) {
                                console.log(req.ip + " (" + req.headers["x-real-ip"] + ") " + " uploaded game #" + counter + ": " + sgfhash + " ERROR: " + err);
                                res.send("Game data " + sgfhash + " stored in database\n");
                            } else {
                                let message = `in ${Math.round(Date.now() / 1000 - req.body.task_time)}s `;
                                if (ELF_NETWORKS.includes(networkhash)) {
                                    elf_counter++;
                                    message += `ELF game #${elf_counter}`;
                                } else {
                                    counter++;
                                    message += `LZ game #${counter}`;
                                }
                                console.log(`${req.ip} (${req.headers["x-real-ip"]}) uploaded ${message}: ${sgfhash}`);
                                res.send("Game data " + sgfhash + " stored in database\n");
                            }
                        }
                    );

                    db.collection("networks").updateOne(
                        { hash: networkhash },
                        { $inc: { game_count: 1 } },
                        { },
                        err => {
                            if (err) {
                                if (ELF_NETWORKS.includes(networkhash))
                                    console.log(req.ip + " (" + req.headers["x-real-ip"] + ") " + " uploaded ELF game #" + elf_counter + ": " + sgfhash + " INCREMENT ERROR: " + err);
                                else
                                    console.log(req.ip + " (" + req.headers["x-real-ip"] + ") " + " uploaded LZ game #" + counter + ": " + sgfhash + " INCREMENT ERROR: " + err);
                            } else {
                                //console.log("Incremented " + networkhash);
                            }
                        }
                    );

                    if (req.body.selfplay_id) {
                        const selfplay_id = ObjectId(req.body.selfplay_id);
                        db.collection("self_plays").updateOne(
                            { _id: selfplay_id },
                            { $inc: { game_count: 1 } },
                            { },
                            (err, dbres) => {
                                if (err) console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " selfplay " + selfplay_id + " INCREMENT ERROR: " + err);
                            }
                        );

                        const selfplay_index = pending_selfplays.findIndex(s => s._id == req.body.selfplay_id);
                        if (selfplay_index != -1) {
                            const selfplay = pending_selfplays[selfplay_index];
                            const request_index = selfplay.requests.findIndex(e => e.seed === seed_from_mongolong(req.body.random_seed));
                            if (request_index !== -1) {
                                selfplay.requests.splice(request_index, 1);
                            }
                            selfplay.game_count++;
                            if (selfplay.game_count >= selfplay.number_to_play) {
                                pending_selfplays.splice(selfplay_index, 1);
                            }
                        }
                    }

                    get_best_network_hash().then( (hash) => {
                        if (hash == networkhash) {
                            // only create branches if the game corresponds to the current best network hash
                            // to avoid long sequences of self-play with old networks.
                            const branches = generate_branches(sgffile);
                            if (branches.length > 0) {
                                const selfplay_promise = req.body.selfplay_id ?
                                    db.collection("self_plays").findOne({ _id: ObjectId(req.body.selfplay_id) }) :
                                    Promise.resolve(null);
                                selfplay_promise.then( (selfplay) => {
                                    for (const branch of branches) {
                                        const set =  {
                                            priority: branch.priority,
                                            komi: selfplay ? selfplay.komi +  branch.komi : default_komi + branch.komi,
                                            noise_value: selfplay ? selfplay.noise_value : default_noise_value,
                                            lambda: selfplay ? selfplay.lambda : default_lambda,
                                            dumbpass: (selfplay && ('dumbpass' in selfplay)) ? selfplay.dumbpass : config.default_dumbpass,
                                            visits: selfplay ? selfplay.visits : default_visits,
                                            resignation_percent: selfplay ? selfplay.resignation_percent : default_resignation_percent,
                                            no_resignation_probability: selfplay ? selfplay.no_resignation_probability : default_no_resignation_probability,
                                            other_options: selfplay ? selfplay.other_options : default_other_options_selfplay,
                                            number_to_play: 1,
                                            game_count: 0,
                                            networkhash: networkhash,
                                            sgfhash: sgfhash,
                                            movescount: branch.move,
                                            ip: req.headers['x-real-ip'] || req.ip
                                        };

                                        db.collection("self_plays").insertOne(set,{},
                                            (err, dbres) => {
                                                if (err)
                                                    console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " LZ game #" + counter + ": error adding branch");
                                                else
                                                    console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " LZ game #" + counter + ": added branch at move " + branch.move);
                                            });

                                        set.requests = []
                                        pending_selfplays.unshift(set);
                                    }
                                }).catch( () =>  {
                                    console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " LZ game #" + counter + ": ERROR RETRIEVING SELFPLAY REQUEST");
                                });
                            }
                        }
                    });
                }
            });
        }
    });
    }
});

app.get("/matches", asyncMiddleware(async(req, res) => {
    const pug_data = {
        matches: await dbutils.get_matches_from_cache(db)
    };

    res.render("matches", pug_data);
}));

app.get("/matches-all", asyncMiddleware(async(req, res) => {
    const pug_data = {
        matches: await dbutils.get_matches_from_db(db, { limit: 1000000 })
    };

    res.render("matches-all", pug_data);
}));

app.get('/analyze/:hash(\\w+)', asyncMiddleware(async (req, res, next) => {
    const game = await db.collection("games")
        .findOne( { sgfhash: req.params.hash }, { sgf: true });
    if (! game) {
        return res.status(404).render("404");
    }
    const result = analyze_sgf(game.sgf);
    res.send(result);
}));

app.get("/network-profiles", asyncMiddleware(async(req, res) => {
    const networks = await db.collection("networks")
        .find({
            hash: { $not: { $in: ELF_NETWORKS } },
            $or: [
                { game_count: { $gt: 0 } },
                { hash: get_best_network_hash() }
            ]
        })
        .sort({ _id: -1 })
        .toArray();

    const pug_data = { networks, menu: "network-profiles" };

    pug_data.networks.forEach(network => {
        network.time = network._id.getTimestamp().getTime();
    });

    res.render("networks/index", pug_data);
}));

app.get("/network-profiles/:hash(\\w+)", asyncMiddleware(async(req, res) => {
    const network = await db.collection("networks")
        .findOne({ hash: req.params.hash });

    if (!network) {
        return res.status(404).render("404");
    }

    // If it's one of the best network, then find it's #
    if ((network.game_count > 0 || network.hash == get_best_network_hash()) && !ELF_NETWORKS.includes(network.hash)) {
        network.networkID = await db.collection("networks")
            .count({
                _id: { $lt: network._id },
                game_count: { $gt: 0 },
                hash: { $not: { $in: ELF_NETWORKS } }
            });
    }

    // Prepare Avatar
    const avatar_folder = path.join(__dirname, "static", "networks");
    if (!await fs.pathExists(avatar_folder)) {
        await fs.mkdirs(avatar_folder);
    }

    const avatar_path = path.join(avatar_folder, network.hash + ".png");
    if (!fs.pathExistsSync(avatar_path)) {
        const retricon = require("retricon-without-canvas");

        await new Promise((resolve, reject) => {
            // GitHub style
            retricon(network.hash, { pixelSize: 70, imagePadding: 35, bgColor: "#F0F0F0" })
                .pngStream()
                .pipe(fs.createWriteStream(avatar_path))
                .on("finish", resolve)
                .on("error", reject);
        });
    }

    const pug_data = {
        network,
        http_host: req.protocol + "://" + req.get("host"),
        // Have to fetch from db since we only cache 100 recent matches
        matches: await dbutils.get_matches_from_db(db, { network: network.hash }),
        menu: "network-profiles"
    };

    res.render("networks/profile", pug_data);
}));

app.get("/rss", asyncMiddleware(async(req, res) => {
    const rss_path = path.join(__dirname, "static", "rss.xml");
    const best_network_path = path.join(__dirname, "network", "best-network.gz");
    let should_generate = true;
    const http_host = req.protocol + "://" + req.get("host");

    const rss_exists = await fs.pathExists(rss_path);

    if (rss_exists) {
        const best_network_mtimeMs = (await fs.stat(best_network_path)).mtimeMs;
        const rss_mtimeMs = (await fs.stat(rss_path)).mtimeMs;

        // We have new network promoted since rss last generated
        should_generate = best_network_mtimeMs > rss_mtimeMs;
    }

    if (should_generate || req.query.force) {
        const hash = await get_best_network_hash();
        const networks = await db.collection("networks")
            .find({ $or: [{ game_count: { $gt: 0 } }, { hash }], hash: { $not: { $in: ELF_NETWORKS } } })
            .sort({ _id: 1 })
            .toArray();

        const rss_xml = new rss_generator().generate(networks, http_host);

        await fs.writeFile(rss_path, rss_xml);
    }

    res.setHeader("Content-Type", "application/rss+xml");
    res.sendFile(rss_path);
}));

app.get("/home", asyncMiddleware(async(req, res) => {
    const client_list_24hr = await cacheIP24hr.wrap(
        "IP24hr", "5m",
        () => Promise.resolve(db.collection("games").distinct("ip", { _id: { $gt: objectIdFromDate(Date.now() - 1000 * 60 * 60 * 24) } })));

    const client_list_1hr = await cacheIP1hr.wrap("IP1hr", "30s", () => Promise.resolve(db.collection("games").distinct("ip", { _id: { $gt: objectIdFromDate(Date.now() - 1000 * 60 * 60) } })));

    const selfplay_24hr = await db.collection("games").find({ _id: { $gt: objectIdFromDate(Date.now() - 1000 * 60 * 60 * 24) } }).count();

    const selfplay_1hr = await db.collection("games").find({ _id: { $gt: objectIdFromDate(Date.now() - 1000 * 60 * 60) } }).count();

    const match_total = await db.collection("match_games").find().count();

    const match_24hr = await db.collection("match_games").find({ _id: { $gt: objectIdFromDate(Date.now() - 1000 * 60 * 60 * 24) } }).count();

    const match_1hr = await db.collection("match_games").find({ _id: { $gt: objectIdFromDate(Date.now() - 1000 * 60 * 60) } }).count();

    const pug_data = {
        matches: await dbutils.get_matches_from_cache(db, 10),
        stats: {
            client_24hr: client_list_24hr.length,
            client_1hr: client_list_1hr.length,
            selfplay_total: counter,
            selfplay_24hr,
            selfplay_1hr,
            selfplay_elf: elf_counter,
            match_total,
            match_24hr,
            match_1hr
        }
    };

    res.render("index", pug_data);
}));

app.get("/", asyncMiddleware(async(req, res) => {
    console.log(req.ip + " Sending index.html");

    let network_table = "<table class=\"networks-table\" border=1><tr><th colspan=7>Best Network Hash</th></tr>\n";
    network_table += "<tr><th>#</th><th>Upload Date</th><th>Hash</th><th>Size</th><th>Elo</th><th>Games</th><th>Training #</th></tr>\n";

    let leaderboard_all_table = "<table class=\"leaderboard-all-table\" border=1><tr><th colspan=\"5\">Leaderboard</th></tr><tr><th>#</th><th>Computer</th><th>Selfplays</th><th>Matches</th><th>Total</th></tr>\n";
    let leaderboard_recent_table = "<table class=\"leaderboard-recent-table\" border=1><tr><th colspan=\"5\">Last week leaderboard</th></tr><tr><th>#</th><th>Computer</th><th>Selfplays</th><th>Matches</th><th>Total</th></tr>\n";

    let styles = "";

    // Display some self-play for all and by current ip
    const recentSelfplay = {};
    const selfplayProjection = { _id: 0, movescount: 1, networkhash: 1, sgfhash: 1, winnercolor: 1 };
    const saveSelfplay = type => games => {
        recentSelfplay[type] = games.map(({ movescount, networkhash, sgfhash, winnercolor }) => ({
            sgfhash,
            text: `${networkhash.slice(0, 4)}/${movescount}${winnercolor.slice(0, 1)}`
        }));
        return "";
    };

    const cursor = db.collection("networks").aggregate([ { $group: { _id: 1, count: { $sum: "$game_count" } } } ]);
    const totalgames = await cursor.next();

    const best_network_hash = await get_best_network_hash();
    Promise.all([
        cacheIP24hr.wrap("IP24hr", "5m", () =>  dbutils.count_ips(db,1000 * 60 * 60 * 24))
        .then(count_ips => (count_ips + " clients in past 24 hours, ")),
        cacheIP1hr.wrap("IP1hr", "30s", () => dbutils.count_ips(db,1000 * 60 * 60))
        .then(count_ips => (count_ips + " in past hour.<br>")),
        db.collection("games").find({ _id: { $gt: objectIdFromDate(Date.now() - 1000 * 60 * 60 * 24) } }).count()
        .then(count => `${counter} total <a href="/self-plays">self-play games</a> (${count} in past 24 hours, `),
        db.collection("games").find({ _id: { $gt: objectIdFromDate(Date.now() - 1000 * 60 * 60) } }).count()
        .then(count => `${count} in past hour).<br/>`),
        db.collection("match_games").find().count()
        .then(count => `${count} total match games (`),
        db.collection("match_games").find({ _id: { $gt: objectIdFromDate(Date.now() - 1000 * 60 * 60 * 24) } }).count()
        .then(count => `${count} in past 24 hours, `),
        db.collection("match_games").find({ _id: { $gt: objectIdFromDate(Date.now() - 1000 * 60 * 60) } }).count()
        .then(count => `${count} in past hour).<br>`),
        db.collection("networks").aggregate([
            // Exclude ELF network
            { $match: { $and: [{ game_count: { $gt: 0 } }, { hash: { $not: { $in: ELF_NETWORKS } } }] } },
            { $sort: { _id: 1 } },
            { $group: { _id: 1, networks: { $push: { _id: "$_id", hash: "$hash", game_count: "$game_count", training_count: "$training_count", filters: "$filters", blocks: "$blocks", rating: "$rating" } } } },
            { $unwind: { path: "$networks", includeArrayIndex: "networkID" } },
            { $project: { _id: "$networks._id", hash: "$networks.hash", game_count: "$networks.game_count", training_count: "$networks.training_count", filters: "$networks.filters", blocks: "$networks.blocks", rating: "$networks.rating", networkID: 1 } },
            { $sort: { networkID: -1 } },
            { $limit: 10000 }
        ])
        //db.collection("networks").find({ game_count: { $gt: 0 } }, { _id: 1, hash: 1, game_count: 1, training_count: 1}).sort( { _id: -1 } ).limit(100)
        .toArray()
        .then(list => {
            for (const item of list) {
                const itemmoment = new moment(item._id.getTimestamp());

                totalgames.count -= item.game_count;

                if (!ELF_NETWORKS.includes(item.hash)) network_table += "<tr><td>"
                    + item.networkID
                    + "</td><td>"
                    + itemmoment.utcOffset(1).format("YYYY-MM-DD HH:mm")
                    + "</td><td><a href=\"/networks/"
                    + item.hash
                    + ".gz\">"
                    + item.hash.slice(0, 8)
                    + "</a></td><td>"
                    + (item.filters && item.blocks ? `${item.blocks}x${item.filters}` : "TBD")
                    + "</td><td>"
                    + Math.floor(item.rating)
//                    + ~~bestRatings.get(item.hash)
                    + "</td><td>"
                    + item.game_count
                    + "</td><td>"
                    + ((item.training_count === 0 || item.training_count) ? item.training_count : totalgames.count)
                    + "</td></tr>\n";
            }

            network_table += "</table>\n";
            return "";
        }),
        db.collection("games").find({ ip: req.ip }, selfplayProjection).hint("ip_-1__id_-1").sort({ _id: -1 }).limit(10).toArray()
        .then(saveSelfplay("ip")),
        db.collection("match_games").find(
            { winnerhash: best_network_hash, winnercolor: { $ne: "jigo" }  },
            { _id: 0, winnerhash: 1, loserhash: 1, sgfhash: 1 }
        ).sort({ _id: -1 }).limit(1).toArray()
        .then(game => {
            if (game[0]) {
                return "<br>"
                    + "View most recent match win by best network " + game[0].winnerhash.slice(0, 8) + " vs " + game[0].loserhash.slice(0, 8) + ": "
                    + "[<a href=\"/viewmatch/" + game[0].sgfhash + "?viewer=eidogo\">EidoGo</a> / "
                    + "<a href=\"/viewmatch/" + game[0].sgfhash + "?viewer=wgo\">WGo</a>] "
                    + "<br>";
            } else {
                return "";
            }
        }),
        db.collection("games").find({}, selfplayProjection).sort({ _id: -1 }).limit(10).toArray()
        .then(saveSelfplay("all")),
        cacheleaders.wrap("leaderboardall", "10m", () => dbutils.leaderboard(db))
        .then(list => {
            const res = Object.values(list).sort( (x,y) => y.total_games - x.total_games ).slice(0,16);
            let pos = 1;
            for (item of res) {
                leaderboard_all_table += "<tr><td>" + pos +"</td><td>" + item.username + "</td><td>" + item.games + "</td><td>" + item.match_games + "</td><td>" + item.total_games + "</td></tr>\n";
                pos += 1;
            }
            leaderboard_all_table += "</table>";
            return "";
        }),
        cacheleaders.wrap("leaderboardweek", "10m", () => dbutils.leaderboard(db, 1000 * 60 * 60 * 24 * 7))
        .then(list => {
            const res = Object.values(list).sort( (x,y) => y.total_games - x.total_games ).slice(0,16);
            let pos = 1;
            for (item of res) {
                leaderboard_recent_table += "<tr><td>" + pos +"</td><td>" + item.username + "</td><td>" + item.games + "</td><td>" + item.match_games + "</td><td>" + item.total_games + "</td></tr>\n";
                pos += 1;
            }
            leaderboard_recent_table += "</table>";
            return "";
        }),
        cachematches.wrap("matches", "1d", () => Promise.resolve(
        db.collection("matches").aggregate([ { $lookup: { localField: "network2", from: "networks", foreignField: "hash", as: "merged" } }, { $unwind: "$merged" }, { $lookup: { localField: "network1", from: "networks", foreignField: "hash", as: "merged1" } }, { $unwind: "$merged1" }, { $sort: { _id: -1 } }, { $limit: 100 } ])
        .toArray()
        .then(list => {
            let match_table = "<table class=\"matches-table\" border=1><tr><th colspan=5>Test Matches (100 Most Recent)</th></tr>\n";
            match_table += "<tr><th>Start Date</th><th>Network Hashes</th><th>Wins : Draws : Losses</th><th>Games</th><th>Type</th></tr>\n";
            styles += ".match-test { background-color: rgba(0,0,0,0.1); font-style: italic; }\n";

            for (const item of list) {
                // The aggregate query above should not return any null network2 matches, but let's be safe.
                //
                if (item.network2 === null) continue;

                let win_percent = item.game_count ? (50 * (1 + (item.network1_wins - item.network1_losses) / item.game_count)).toFixed(2) : null;
                const itemmoment = new moment(item._id.getTimestamp());

                if (win_percent) {
                    if (win_percent >= 60) {
                        win_percent = "<b>" + win_percent + "</b>";
                    }
                    win_percent = " (" + win_percent + "%)";
                }

                match_table += `<tr class="match-${item.is_test ? "test" : "regular"}">`
                    + "<td>" + itemmoment.utcOffset(1).format("YYYY-MM-DD HH:mm") + "</td>"
                    + "<td>"
                    + "<div class=\"tooltip\">"
                    + "<a href=\"/networks/" + item.network1 + ".gz\">" + item.network1.slice(0, 8) + "</a>"
                    + "<span class=\"tooltiptextleft\">"
                    + item.merged1.training_count.abbr(4)
                    + (item.merged1.training_steps ? "+" + item.merged1.training_steps.abbr(4) : "")
                    + (item.merged1.filters && item.merged1.blocks ? `<br/>${item.merged1.blocks}x${item.merged1.filters}` : "")
                    + (item.merged1.description ? `<br/>${item.merged1.description}` : "")
                    + "</span></div>&nbsp;"
                    + "<div class=\"tooltip\">"
                    + " <a href=\"/match-games/" + item._id + "\">VS</a> "
                    + "<span class=\"tooltiptextright\">"
                    + (item.is_test ? "Test" : "Regular") + " Match"
                    + "</span>"
                    + "</div>&nbsp;"
                    ; // eslint-disable-line semi-style

                if (item.network2) {
                    match_table += "<div class=\"tooltip\">"
                        + "<a href=\"/networks/" + item.network2 + ".gz\">" + item.network2.slice(0, 8) + "</a>"
                        + "<span class=\"tooltiptextright\">"
                        + item.merged.training_count.abbr(4)
                        + (item.merged.training_steps ? "+" + item.merged.training_steps.abbr(4) : "")
                        + (item.merged.filters && item.merged.blocks ? `<br/>${item.merged.blocks}x${item.merged.filters}` : "")
                        + (item.merged.description ? `<br/>${item.merged.description}` : "")
                        + "</span></div>";
                } else {
                    match_table += "BEST";
                }

                match_table += "</td>"
                    + "<td>" + item.network1_wins + " : " + (item.game_count - item.network1_losses - item.network1_wins) + " : " + item.network1_losses
                        + (win_percent ? win_percent + "</td>" : "</td>")
                    + "<td>" + item.game_count + " / " + item.number_to_play + "</td>";
                    // + "<td>";
                match_table += "<td>" + ( item.type ? item.type : "" ) + "</td>";

                // // Treat non-test match that has been promoted as PASS
                // const promotedMatch = bestRatings.has(item.network1) && !item.is_test;
                // switch (promotedMatch || SPRT(item.network1_wins, item.network1_losses)) {
                //     case true:
                //         match_table += "<b>PASS</b>";
                //         break;
                //     case false:
                //         match_table += "<i>fail</i>";
                //         break;
                //     default: {
                //         // -2.9444389791664403 2.9444389791664403 == range of 5.88887795833
                //         let width = Math.round(100 * (2.9444389791664403 + LLR(item.network1_wins, item.network1_losses, 0, 35)) / 5.88887795833);
                //         let color;

                //         if (width < 0) {
                //             color = "C11B17";
                //             width = 0;
                //         } else if (width > 100) {
                //             color = "0000FF";
                //             width = 100;
                //         } else {
                //             color = "59E817";
                //         }

                //         styles += ".n" + item.network1.slice(0, 8) + "{ width: " + width + "%; background-color: #" + color + ";}\n";
                //         match_table += "<div class=\"n" + item.network1.slice(0, 8) + "\">&nbsp;</div>";
                //     }
                // }

                // match_table += "</td></tr>\n";
                match_table += "</tr>\n";
            }

            match_table += "</table>\n";
            return [styles, match_table];
        })
        ))
    ]).then(responses => {
        const match_and_styles = responses.pop();

        const styles = match_and_styles[0];
        const match_table = match_and_styles[1];

        let page = "<html><head>\n<title>Leela Zero / SAI</title>\n";
        page += "<script type=\"text/javascript\" src=\"/static/timeago.js\"></script>\n";
        page += "<style>";
        page += "table.networks-table { float: left; margin-right: 40px; margin-bottom: 20px; }\n";
        page += "table.leaderboard-all-table { float: left; margin-right: 40px; margin-bottom: 20px; }\n";
        page += styles;

        // From https://www.w3schools.com/css/css_tooltip.asp
        //
        page += ".tooltip { position: relative; display: inline-block; border-bottom: 1px dotted black; }\n";

        page += ".tooltip .tooltiptextright { visibility: hidden; width: 130px; background-color: black; color: #fff; text-align: center; border-radius: 6px; padding: 5px 0; position: absolute; z-index: 1; top: -5px; left: 110%; }\n";
        page += " .tooltip .tooltiptextright::after { content: \"\"; position: absolute; top: 50%; right: 100%; margin-top: -5px; border-width: 5px; border-style: solid; border-color: transparent black transparent transparent; }\n";
        page += " .tooltip:hover .tooltiptextright { visibility: visible; }\n";

        page += ".tooltip .tooltiptextleft { visibility: hidden; width: 130px; background-color: black; color: #fff; text-align: center; border-radius: 6px; padding: 5px 0; position: absolute; z-index: 1; top: -5px; right: 110%; }\n";
        page += " .tooltip .tooltiptextleft::after { content: \"\"; position: absolute; top: 50%; left: 100%; margin-top: -5px; border-width: 5px; border-style: solid; border-color: transparent transparent transparent black; }\n";
        page += " .tooltip:hover .tooltiptextleft { visibility: visible; }\n";

        page += "</style>\n";
        page += "</head><body>\n";

        page += "<p><strong>Would you like to contribute?</strong> If you have a computer with a recent GPU and updated drivers, "
        page += "and are willing to let it run for some hours per day, please do as follows:</p>"
        page += "<ol>"
        page += "<li>Create computername and password following <a target=\"_blank\" href=\"user-request\">this link</a> (open in new tab)</li>"
        page += "<li>If you are a Windows user:"
        page += "<ol>"
        page += "<li>Open <a href=\"https://github.com/sai-dev/sai/releases/\">this page</a> and download the latest release of SAI fitting the characteristics of your computer.</li>"
        page += "<li>Double click on the exe file, this will unzip the archive.</li>"
	page += "<li>Double-click on sai.hta – authorization for this operation may be requested, if so please grant it</li>"
        page += "</ol>"
        page += "<li>If you are a Linux or macOS user, follow this link: <a href=\"https://github.com/sai-dev/sai#macos-and-linux\">https://github.com/sai-dev/sai#macos-and-linux</a>"
        page += "</ol>"

        page += "<p>Notice that after downloading SAI, <strong>you will be able to play with the superhuman SAI 9x9!</strong> <em>This is a superhuman "
        page +=" bot and can play with arbitrary komi – with 6 additional komi points a strong player may beat it.</em> You will also be able to "
        page += "play with SAI 19x19, however on this board SAI will be quite weak for many months. "
        page += "In order to play, if you are a Windows user, please double click on sai9x9.bat in the same archive.</p>"

        page += "<p>More details in the <a href=\"https://github.com/sai-dev/sai#what\">Github readme</a> and in the <a href=\"https://github.com/sai-dev/sai/wiki\">wiki</a></p>"
        page += "<hr>"

        page += "Autogtp will automatically download better networks once found.<br>";
        page += "Not each trained network will be a strength improvement over the prior one. Patience please. :)<br>";
        page += "Match games are played at full strength (only " + default_visits + " visits).<br>";
        if (default_randomcnt < 999)
            page += "Self-play games are played with some randomness in first " + default_randomcnt + " moves, and noise all game long.<br>";
        else
            page += "Self-play games are played with some randomness and noise for all moves.<br>";
        page += "Training data from self-play games are full strength even if plays appear weak.<br>";
        page += "<br>";
        page += "SAI is derived from Leela Zero 0.17 + AutoGTP v18.<br>";
        page += "<br>";

        responses.map(response => page += response);

        ["all", "ip"].forEach(type => {
            const games = recentSelfplay[type];
            if (games && games.length) {
                page += `View ${type == "ip" ? "your " : ""}most recent self-play games: `;
                page += games.map(({ sgfhash, text }) => `<a href="/view/${sgfhash}?viewer=wgo">${text}</a>`).join(", ");
                page += "<br>";
            }
        });

        page += "<p>View the <a href=\"leaderboard\">full leaderboard</a> of the contributors.</p>"
        page += leaderboard_all_table;
        page += leaderboard_recent_table;

        page += "<h4>Recent Strength Graph (<a href=\"/static/newelo.html\">Full view</a>.)</h4>";
        page += "The plot shows a proper Bayes-Elo rating, computed on the set of all played matches.<br>";
        page += "<h4>The x-axis scale is 1/" + LZGRAPHSCALE + " for Leela Zero networks (grey crosses).</h4><br>";
        page += "<iframe width=\"1100\" height=\"655\" seamless frameborder=\"0\" scrolling=\"no\" src=\"/static/newelo.html?0#recent=" + GRAPHRECENT + "\"></iframe><script>(i => i.contentWindow.location = i.src)(document.querySelector(\"iframe\"))</script>";
        page += "<br><br>Times are in GMT+0100 (CET)<br>\n";
        page += network_table;
        page += match_table;
        page += "</body></html>";
        res.send(page);
    });
}));

/**
 * Determine which special selfplay should be scheduled.
 *
 * @param req {object} Express request
 * @param now {int} Timestamp right now
 * @returns {bool|object} False if no selfplay to schedule; otherwise, selfplay object
 */
function shouldScheduleSelfplay (req, now) {
  if ( !(pending_selfplays.length && req.params.autogtp != 0) )
    return false;

  let i = pending_selfplays.length;
  while (--i >= 0) {
    const selfplay = pending_selfplays[i];
    const deleted = selfplay.requests.filter(e => e.timestamp < now - SELFPLAY_EXPIRE_TIME).length;
    selfplay.requests.splice(0, deleted);
    const requested = selfplay.requests.length;
    if (selfplay.number_to_play > selfplay.game_count + requested)
        return selfplay;
  }
  return false;
}

/**
 * Determine if a match should be scheduled for a given request.
 *
 * @param req {object} Express request
 * @param now {int} Timestamp right now
 * @returns {bool|object} False if no match to schedule; otherwise, match object
 */
function shouldScheduleMatch(req, now) {
  if (!(pending_matches.length && req.params.autogtp != 0 && (schedule_matches_to_all || fastClientsMap.get(req.ip)))) {
    return false;
  }

  // Find the first match this client can play, starting from a random match
  // and looping until something to do is found or all maches are scheduled
  let i = pending_matches.length;
  const rot = Math.floor(Math.random() * pending_matches.length);
  while (--i >= 0) {
    let j = ( i + rot ) % pending_matches.length;
    let match = pending_matches[j];

    const deleted = match.requests.filter(e => e.timestamp < now - MATCH_EXPIRE_TIME).length;
    const oldest = (match.requests.length > 0 ? (now - match.requests[0].timestamp) / 1000 / 60 : 0).toFixed(2);
    match.requests.splice(0, deleted);
    const requested = match.requests.length;
    const needed = how_many_games_to_queue(
      match.number_to_play,
      match.network1_wins,
      match.network1_losses,
      PESSIMISTIC_RATE,
      bestRatings.has(match.network1),
      no_early_fail);

    const result = needed > requested;
    console.log(`Need ${needed} match games. Requested ${requested}, deleted ${deleted}. Oldest ${oldest}m ago. Will ${result ? "" : "not"} schedule match.`);

    if (result) {
      return match;
    }
  }

  // Don't schedule if we ran out of potential matches for this client
  console.log(`No need of match games. Will schedule self-play.`);
  return false;
}

/**
 * Get a self-play or match task depending on various client versions.
 * E.g., /get-task/0, /get-task/16, /get-task/0/0.14, /get-task/16/0.14
 */
async function get_task(req, res) {
    const required_client_version = String(16);
    const required_leelaz_version = String("0.15");

    // Pulling this now because if I wait inside the network2==null test, possible race condition if another get-task pops end of array?
    //
    const best_network_hash = await get_best_network_hash();
    const now = Date.now();
    const random_seed = make_seed(now / 1000).toString();

    // Track match assignments as they go out, so we don't send out too many. If more needed request them, otherwise selfplay.
    //
    const match = shouldScheduleMatch(req, now);
    if (match) {
        const task = { cmd: "match", required_client_version, minimum_autogtp_version: required_client_version, random_seed, minimum_leelaz_version: required_leelaz_version };

        if (match.options.visits) match.options.playouts = "0";

        task.options = match.options;
        task.options_hash = match.options_hash;

        if (match.network2 == null) {
            match.network2 = best_network_hash;

            db.collection("matches").updateOne(
                { network1: match.network1, network2: null, options_hash: match.options_hash },
                { $set: { network2: best_network_hash } },
                { },
                err => {
                    if (err) {
                        console.log("ERROR: /get-task setting network2: " + err);
                        res.send("ERROR: /get-task setting network2: " + err);
                        return;
                    }
                    dbutils.clear_matches_cache();
                    console.log("Match " + match._id + " set network2 to best: " + match.network2);
            });
        }

        match.game_color = !match.game_color;

        if (match.game_color) {
            task.white_hash = match.network1;
            task.black_hash = match.network2;
        } else {
            task.white_hash = match.network2;
            task.black_hash = match.network1;
        }

        add_match_verification(task);
        await add_gzip_hash(task);
        res.send(JSON.stringify(task));

        match.requests.push({ timestamp: now, seed: random_seed });

        if (match.game_count >= match.number_to_play) {
            const pending_match_index = pending_matches.findIndex(m => m._id.equals(match._id));
            pending_matches.splice(pending_match_index, 1);
        }

        console.log(`${req.ip} (${req.headers["x-real-ip"]}) got task: match ${match.network1.slice(0, 8)} vs ${match.network2.slice(0, 8)} ${match.game_count + match.requests.length} of ${match.number_to_play} ${JSON.stringify(task)}`);
//    } else if ( req.params.autogtp==1 && Math.random() > .2 ) {
//        const task = { "cmd": "wait", "minutes": "5" };
//
//        res.send(JSON.stringify(task));
//
//        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " got task: wait");
    } else {
        const self_play = shouldScheduleSelfplay(req, now);

        // {"cmd": "selfplay", "hash": "xxx", "playouts": 1000, "resignation_percent": 3.0}
        const task = (!self_play && disable_default_selfplay) ?
            { "cmd": "wait", "minutes": "5" }:
            { cmd: "selfplay", hash: "", required_client_version, minimum_autogtp_version: required_client_version, random_seed, minimum_leelaz_version: required_leelaz_version };

        //var options = {"playouts": "1600", "resignation_percent": "10", "noise": "true", "randomcnt": "30"};
        const options = { playouts: "0", visits: String(default_visits), resignation_percent: String(default_resignation_percent), noise: "true", randomcnt: String(default_randomcnt),
                          komi: String(default_komi), noise_value: String(default_noise_value), lambda: String(default_lambda), other_options: String(default_other_options_selfplay),
                          dumbpass: String(config.default_dumbpass) };

        if (self_play) {
            options.komi = String(self_play.komi);
            options.noise_value = String(self_play.noise_value);
            options.lambda = String(self_play.lambda);
            if ('dumbpass' in self_play) options.dumbpass =  String(self_play.dumbpass);
            options.visits = String(self_play.visits);
            options.resignation_percent = String(self_play.resignation_percent);
            options.other_options = String(self_play.other_options);
            if (self_play.noise) options.noise = String(self_play.noise);
            task.hash = String(self_play.networkhash);
            task.selfplay_id = String(self_play._id);
            if (self_play.sgfhash) {
                task.sgfhash = String(self_play.sgfhash);
                task.movescount = String(self_play.movescount);
            }
            self_play.requests.push({ timestamp: now, seed: random_seed });
            if (Math.random() < self_play.no_resignation_probability) options.resignation_percent = "0";
        } else if (! disable_default_selfplay || req.params.autogtp == 0) {
            task.hash = best_network_hash;
            if (Math.random() < default_no_resignation_probability) options.resignation_percent = "0";
        }

        // For now, have newer autogtp and leelaz play some self-play with
        // Facebook's ELF Open Go network, which uses network version 2.
        //if ((req.params.autogtp >= 16 || req.params.leelaz >= 0.14) && Math.random() < 0.25) {
        //    task.hash = ELF_NETWORKS[1];
        //    options.resignation_percent = "5";
        //}

        //task.options_hash = checksum("" + options.playouts + options.resignation_percent + options.noise + options.randomcnt).slice(0,6);
        if (task.cmd != 'wait') {
            task.options_hash = get_options_hash(options);
            task.options = options;
        }
        await add_gzip_hash(task);
        res.send(JSON.stringify(task));

        console.log(`${req.ip} (${req.headers["x-real-ip"]}) got task: selfplay ${JSON.stringify(task)}`);
    }
}

// GET version of get-task
app.get("/get-task/:autogtp(\\d+)(?:/:leelaz([.\\d]+)?)", asyncMiddleware(async(req, res) => {
    get_task(req,res);
}));

// POST version of get-task with authentication
app.post("/get-task/:autogtp(\\d+)(?:/:leelaz([.\\d]+)?)", asyncMiddleware(async(req, res) => {
    const username = validate_user(req.body.username, req.body.password, req.body.key);
    if (username === false) {
        console.log(`${req.ip} (${req.headers['x-real-ip']}) /get-task: invalid authentication for "${req.body.username}"`);
        return res.status(400).send("Invalid authentication");
    } else
        get_task(req,res);
}));

app.post('/request-selfplay',  asyncMiddleware( async (req, res, next) => {
    const logAndFail = msg => {
        console.log(`${req.ip} (${req.headers['x-real-ip']}) /request-selfplay: ${msg}`);
        console.log(`files: ${JSON.stringify(Object.keys(req.files || {}))}, body: ${JSON.stringify(req.body)}`);
        return res.status(400).send(msg+"\n");
    };

    let best_network_hash = await get_best_network_hash()

    if (!req.body.key || req.body.key != auth_key) {
        console.log("AUTH FAIL: '" + String(req.body.key) + "' VS '" + String(auth_key) + "'");

        return res.status(400).send('Incorrect key provided.');
    }

    if (req.body.sgfhash && req.body.networkhash)
        return logAndFail('Both parameters sgfhash and networkhash are provided');
    if (! req.body.priority)
        return logAndFail('No priority provided');

    const set =  {
        priority: parseFloat(req.body.priority),
        noise_value: req.body.noise_value  ? parseFloat(req.body.noise_value) : default_noise_value,
        noise: req.body.noise ? req.body.noise.toLowerCase() == "true" : "true",
        komi: req.body.komi ? parseFloat(req.body.komi) : default_komi,
        lambda: req.body.lambda ? parseFloat(req.body.lambda) : default_lambda,
        dumbpass: ("dumbpass" in req.body) ? req.body.dumbpass.toLowerCase() === "true" : config.default_dumbpass,
        other_options: 'other_options' in req.body ? String(req.body.other_options) : default_other_options_selfplay,
        number_to_play: req.body.number_to_play ? parseInt(req.body.number_to_play) : 1,
        visits: req.body.visits ? parseInt(req.body.visits) : default_visits,
        resignation_percent: req.body.resignation_percent ? parseFloat(req.body.resignation_percent) : default_resignation_percent,
        no_resignation_probability: req.body.no_resignation_probability ? parseFloat(req.body.no_resignation_probability) : default_no_resignation_probability,
        game_count: 0,
        ip: req.headers['x-real-ip'] || req.ip
    };

    if (req.body.sgfhash) {
        if (! req.body.movescount)
            return logAndFail('No movescount provided, although sgfhash is provided');
        const selfplay = await db.collection("games").findOne({ "sgfhash": req.body.sgfhash }, { _id: 1, networkhash: 1 });
        if (! selfplay)
            return logAndFail("No selfplay was found with hash " + req.body.sgfhash);
        set.networkhash = selfplay.networkhash;
        set.sgfhash = req.body.sgfhash;
        set.movescount = parseInt(req.body.movescount);
    } else if (req.body.networkhash) {
        const network = await db.collection("networks").findOne({ "hash": req.body.networkhash }, { _id: 1 });
        if (! network)
            return logAndFail("No network was found with hash " + req.body.networkhash);
        set.networkhash = req.body.networkhash;
    } else {
        set.networkhash = best_network_hash;
    }

    await db.collection("self_plays").insertOne(set);
    if ( set.networkhash == best_network_hash ) {
        set.requests = [];
        pending_selfplays.unshift(set);
    }

    console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " uploaded self-play");
    res.send("Self-play request for game " + set.sgfhash + " network "  + set.networkhash + " stored in database.\n");
}));

app.get("/view/:hash(\\w+).sgf", (req, res) => {
    db.collection("games").findOne({ sgfhash: req.params.hash }, { _id: 0, sgf: 1 })
    .then(({ sgf }) => {
        sgf = sgf.replace(/(\n|\r)+/g, "");

        res.setHeader("Content-Disposition", "attachment; filename=\"" + req.params.hash + ".sgf\"");
        res.setHeader("Content-Type", "application/x-go-sgf");
        res.send(sgf);
    }).catch(() => {
        res.send("No self-play was found with hash " + req.params.hash);
    });
});

app.get("/view/:hash(\\w+)", (req, res) => {
    db.collection("games").findOne({ sgfhash: req.params.hash }, { _id: 0, sgf: 1 })
    .then(({ sgf }) => {
        sgf = sgf.replace(/(\n|\r)+/g, "");

        switch (req.query.viewer) {
            case "eidogo":
                res.render("eidogo", { title: "View training game " + req.params.hash, sgf });
                break;
            case "wgo":
                res.render("wgo", { title: "View training game " + req.params.hash, sgf });
                break;
            default:
                res.render("eidogo", { title: "View training game " + req.params.hash, sgf });
        }
    }).catch(() => {
        res.send("No selfplay game was found with hash " + req.params.hash);
    });
});

app.get("/self-plays", (req, res) => {
    db.collection("games").find({}, { data: 0 }).sort({ _id: -1 }).limit(1200).toArray()
    .then(list => {
        process_games_list(list, req.ip);
        // render pug view self-plays
        res.render("self-plays", { data: list });
    }).catch(() => {
        res.send("Failed to get recent self-play games");
    });
});

app.get("/match-games/:matchid(\\w+)", (req, res) => {
    if (!req.params.matchid) {
        res.send("matchid missing");
        return;
    }

    db.collection("matches").findOne({ _id: new ObjectId(req.params.matchid) })
        .then(match => {
            db.collection("match_games").aggregate([
                {
                    $match: {
                        $or: [
                            { winnerhash: match.network1, loserhash: match.network2, options_hash: match.options_hash },
                            { winnerhash: match.network2, loserhash: match.network1, options_hash: match.options_hash }
                        ]
                    }
                },
                { $sort: { _id: 1 } }
            ]).toArray()
                .then(list => {
                    process_games_list(list, req.ip, match.network1);
                    // render pug view match-games
                    res.render("match-games", { data: list });
                }).catch(() => {
                    res.send("No matches found for match " + req.params.matchid);
                });
        }).catch(() => {
            res.send("No match found for id " + req.params.hash);
        });
});

app.get("/viewmatch/:hash(\\w+).sgf", (req, res) => {
    db.collection("match_games").findOne({ sgfhash: req.params.hash }, { _id: 0, sgf: 1 })
    .then(({ sgf }) => {
        sgf = sgf.replace(/(\n|\r)+/g, "");

        res.setHeader("Content-Disposition", "attachment; filename=\"" + req.params.hash + ".sgf\"");
        res.setHeader("Content-Type", "application/x-go-sgf");
        res.send(sgf);
    }).catch(() => {
        res.send("No match was found with hash " + req.params.hash);
    });
});

app.get("/viewmatch/:hash(\\w+)", (req, res) => {
    db.collection("match_games").findOne({ sgfhash: req.params.hash }, { _id: 0, sgf: 1 })
    .then(({ sgf }) => {
        sgf = sgf.replace(/(\n|\r)+/g, "");

        switch (req.query.viewer) {
            case "eidogo":
                res.render("eidogo", { title: "View training game " + req.params.hash, sgf });
                break;
            case "wgo":
                res.render("wgo", { title: "View match " + req.params.hash, sgf });
                break;
            default:
                res.render("eidogo", { title: "View training game " + req.params.hash, sgf });
        }
    }).catch(() => {
        res.send("No match was found with hash " + req.params.hash);
    });
});

app.get("/leaderboard", asyncMiddleware(async(req, res) => {
    const counts = await Promise.all([
        cacheleaders.wrap("leaderboardall", "10m", () =>  dbutils.leaderboard(db)),
        cacheleaders.wrap("leaderboardweek", "10m", () => dbutils.leaderboard(db, 1000 * 60 * 60 * 24 * 7))
    ]);
    const dict = counts[0];
    for (let key in counts[1]) {
        const a = dict[key]
        if (typeof a != "undefined") {
            const l = counts[1][key];
            a.games_recent = l.games
            a.match_games_recent = l.match_games
            a.total_games_recent = l.total_games
        }
    }
    res.render("leaderboard", { data: dict });
}));

app.get("/data/elograph.json", asyncMiddleware(async(req, res) => {
    // cache in `cachematches`, so when new match result is uploaded, it gets cleared as well
    const json = await cachematches.wrap("elograph", "1d", async() => {
    console.log("fetching data for elograph.json, should be called once per day or when `cachematches` is cleared");

    const cursor = db.collection("networks").aggregate([ { $group: { _id: 1, count: { $sum: "$game_count" } } } ]);
    const totalgames = await cursor.next();

    return Promise.all([
        db.collection("networks").find().sort({ _id: -1 }).toArray(),
        db.collection("matches").aggregate([
            { $lookup: { localField: "network2", from: "networks", foreignField: "hash", as: "merged" } },
            { $unwind: "$merged" },
            { $sort: { "merged._id": 1 } }
        ]).toArray()
    ]).then(dataArray => {
        // initialize mapping of best networks to Elo rating cached globally
        bestRatings = new Map();

        // prepare networks
        const networks = dataArray[0].map(item => {
            totalgames.count -= item.game_count || 0;

            // The ELF network has games but is not actually best
            const best = item.game_count && !ELF_NETWORKS.some(n => n.startsWith(item.hash));
            if (best)
                bestRatings.set(item.hash, 0);

            return {
                hash: item.hash,
                game_count: item.game_count,
                net: (item.training_count === 0 || item.training_count) ? item.training_count : totalgames.count, // mycount
                best
            };
        });

        // prepare ratingsMap
        const ratingsMap = new Map();
        dataArray[1].forEach(match => {
            const network2_rating = ratingsMap.get(match.network2) ? ratingsMap.get(match.network2).rating : 0;
            let sprt;
            let elo;

            // TODO If no Elo info, make rating -1 for graph to just hide it instead of assuming same Elo as network 2.
            //
            if (match.network1_wins > 0 && match.network1_losses > 0) {
                elo = CalculateEloFromPercent(match.network1_wins / match.game_count);
            } else {
                let fakecount = match.game_count;
                let fakewins = match.network1_wins;

                if (fakewins == 0) {
                    fakewins++;
                    fakecount++;
                }

                if (match.network1_losses == 0) {
                    fakecount++;
                }

                elo = CalculateEloFromPercent(fakewins / fakecount);
            }

            // Hide *-vs-ELF test matches as there's no meaningful Elo reference
            if (ELF_NETWORKS.includes(match.network2)) {
                elo = 0;
            }

            const isBest = bestRatings.has(match.network1);
            switch (isBest || SPRT(match.network1_wins, match.network1_losses)) {
                case false:
                    sprt = "FAIL";
                    break;

                case true:
                    sprt = "PASS";
                    break;

                default:
                    sprt = "???";
            }

            // Force the match to show up as a test instead of the usual SPRT
            if (match.is_test) {
                sprt = "TEST";
            }

            // Save ratings of best networks
            const rating = elo + network2_rating;
            if (isBest && !match.is_test)
                bestRatings.set(match.network1, rating);

            // Use opponent's net for ELF as its training_count is arbitrary
            const net = ELF_NETWORKS.includes(match.network1) && match.merged.training_count;

            // Chain together previous infos if we have any
            const previous = ratingsMap.get(match.network1);
            const info = { net, previous, rating, sprt };
            ratingsMap.set(match.network1, info);
        });

        // Matches table uses data from bestRatings, so allow it to refresh
        cachematches.del("matches", () => console.log("Cleared match table cache."));

        // prepare json result
        const json = [];
        const addNetworkRating = (item, info = { rating: 0, sprt: "???" }) => {
            const rating = Math.max(0, Math.round(info.rating));
            json.push({
                rating,
                net: Math.max(0.0, Number((info.net || item.net) + rating / 100000)),
                sprt: info.sprt,
                hash: item.hash.slice(0, 6),
                best: item.best && info.sprt !== "TEST"
            });

            // Add additional result for multiple matches
            if (info.previous)
                addNetworkRating(item, info.previous);
        };
        networks.forEach(item => addNetworkRating(item, ratingsMap.get(item.hash)));

        // shortcut for sending json result using `JSON.stringify`
        // and set `Content-Type: application/json`
        return json;
    }).catch(err => {
        console.log("ERROR data/elograph.json: " + err);
        res.send("ERROR data/elograph.json: " + err);
    });
    });

    res.json(json);
}));

app.get("/data/newelograph.json", asyncMiddleware(async(req, res) => {
    // cache in `cacheratings`, so when new ratings are uploaded, it gets cleared as well
    const json = await cacheratings.wrap("newelograph", "1d", async() => {
    console.log("fetching data for newelograph.json, should be called once per day or when `cacheratings` is cleared");

    return db.collection("networks").find().sort({ _id: -1 }).toArray()
    .then(networks => {
        // prepare json result
        const json = [];
        networks.forEach(item => {
            if (typeof item.rating != "undefined") {
                const leelaz = item.description ?  item.description.startsWith("LZ") : false;
                json.push({
                    rating: item.rating,
                    net: leelaz ? item.training_steps / LZGRAPHSCALE : Math.max(0.0, Number(item.training_count + item.rating / 100000)),
                    sprt: (
                        leelaz ?
                            "Leela Zero"
                        : item.rating == 0 ?
                            "Random"
                        : item.game_count > 0 ?
                            "PASS " + item.blocks + "x" + item.filters
                        : item.blocks + "x" + item.filters
                    ),
                    pos: (
                        leelaz ?
                            99
                        : item.rating == 0 ?
                            1
                        : item.game_count > 0 ?
                            10 + item.blocks
                        : 50 + item.blocks
                    ),
                    hash: item.description || item.hash.slice(0, 6),
                    best: item.game_count > 0
                })
            }
        });

        // shortcut for sending json result using `JSON.stringify`
        // and set `Content-Type: application/json`
        return json;
    }).catch(err => {
        console.log("ERROR data/newelograph.json: " + err);
        res.send("ERROR data/newelograph.json: " + err);
    });
    });

    res.json(json);
}));

app.post('/submit-ratings', asyncMiddleware(async(req, res) => {
    if (!req.body.key || req.body.key != auth_key) {
        console.log("AUTH FAIL: '" + String(req.body.key) + "' VS '" + String(auth_key) + "'");

        return res.status(400).send("Incorrect key provided.\n");
    }
    if (!req.body.ratings)
        return res.status(400).send("Parameter ratings is missing.\n");

    let json;
    try {
        json = JSON.parse(req.body.ratings);
    } catch(err) {
        return res.status(400).send("Parameters rating is not a valid JSON.\n");
    }
    if (!(json instanceof Array))
        return res.status(400).send("Parameters ratings is not a JSON array.\n");

    cacheratings.clear(() => console.log("Cleared ratings cache."));

    json.forEach(item => {
        if ((typeof item.hash == "string") && (typeof item.rating == "number")) {
            const hash_arr = item.hash.split(':');
            const hash = hash_arr.length == 2 ? hash_arr[1] : item.hash;
            db.collection("networks").updateOne(
                { hash: { $regex: "^"+hash } },
                { $set: { rating: item.rating }},
                { upsert: false }
            );
        }
    });

    res.send("Ratings updated.\n");
}));

/*
app.get("/opening/:start(\\w+)?", asyncMiddleware(async(req, res) => {
    let start = req.params.start;
    const files = {
        44: "top10-Q16.json",
        43: "top10-R16.json",
        33: "top10-R17.json"
    };

    if (!(start in files))
        start = "44";

    const top10 = JSON.parse(fs.readFileSync(path.join(__dirname, "static", files[start])));

    return res.render("opening", { top10, start, menu: "opening" });
}));
*/

app.get("/admin/access-logs", asyncMiddleware(async(req, res) => {
    const url = req.query.url;
    res.render("admin/access-logs", { url });
}));

// Data APIs
app.get("/api/access-logs", asyncMiddleware(async(req, res) => {
    const url = req.query.url;
    const logs = await dbutils.get_access_logs(db, url);
    res.setHeader("Content-Type", "application/json");
    res.send(JSON.stringify(logs));
}));

app.get("/debug/exception", asyncMiddleware(async() => {
    throw new Error("handler error test" + Date.now());
}));

app.get("/debug/promise", (req, res) => {
    const foo = async() => Promise.reject("Unhandled Exception " + Date.now());
    foo();
    res.send("ok");
});

app.post("/user-request", asyncMiddleware(async(req, res) => {
    const logAndFail = msg => {
        console.log(`${req.ip} (${req.headers["x-real-ip"]}) /admin/user-request: ${msg}`);
        return res.status(400).send(msg);
    };

    if ( !req.body.username )
        return logAndFail("Computername not provided.");
    if ( !req.body.email )
        return logAndFail("Email not provided.");
    if ( ! email_validator.validate(req.body.email) )
        return logAndFail("Email format is not valid.");

    if (! req.body.password)
        return logAndFail("No password provided.");
    if (! req.body.password2)
        return logAndFail("No confirmation password provided.");
    if (req.body.password != req.body.password2)
        return logAndFail("Password do not matches.");
    if (req.body.password.length > 254)
        return logAndFail("Password too long.");

    const username = req.body.username;
    const email = req.body.email;

    const hash = crypto.createHash("sha256");
    hash.update(req.body.password);
    const password = hash.digest("hex");

    if ( await db.collection("users").findOne({ username: username }) )
        return logAndFail("User with given computername already exists.");

    const token = crypto.randomBytes(48).toString('base64').replace(/\//g,'_').replace(/\+/g,'-');
    const insert = await db.collection("users").insertOne({ username: username, email: email, password: password, token: token, active: false });

    if (! insert)
        return logAndFail("Error adding user to db.");

    const transporter = nodemailer.createTransport(config.mail_transport);

    const url = config.base_url + 'sai' + instance_number;

    const mail_options = {
        from: config.mail_from,
        to: email,
        cc: config.mail_from,
        subject: "Request for SAI user account",
        text: `Please confirm your email for computer ${username} connecting to ${url}/user-confirm/${encodeURIComponent(username)}/${token}`
    };

    const email_info = await transporter.sendMail(mail_options);
    if (! email_info)
        return logAndFail("Error sending email.");

    console.log(`${req.ip} (${req.headers["x-real-ip"]}) request new computer ${username} for address ${email}.`);
    res.send("OK, an email has been sent to your address. You can now close this window.")
}));

app.get("/user-request", asyncMiddleware(async(req, res) => {
    const pug_data = { };
    res.render("user-request", pug_data);
}));

app.get("/user-confirm/:username/:token", asyncMiddleware(async(req, res) => {
    const logAndFail = msg => {
        console.log(`${req.ip} (${req.headers["x-real-ip"]}) /admin/user-confirm: ${msg}`);
        return res.status(400).send(msg);
    };

    const username = req.params.username;
    const token = req.params.token;

    const command_result = await db.collection("users").findOneAndUpdate({ username: username, token: token },
        { $set: { active: true }, $unset: { token: "" } });
    const user = command_result.value;

    if (! user)
        return logAndFail("Wrong credentials.");
    else {
        current_users.set(user.username, user.password);
        console.log(`${req.ip} (${req.headers["x-real-ip"]}) confirmed user ${username}.`);
        return res.send(`Congratulations! Your account for computer ${username} has been created. You can now close this window.`);
    }
}));

// Catch all, return 404 page not found
app.get("*", asyncMiddleware(async(req, res) => res.status(404).render("404")));

if (config.RAVEN_DSN) {
    app.use(Raven.errorHandler());
}
