const Cacheman = require("cacheman");
const {
    objectIdFromDate,
    SPRT,
    LLR
} = require("./utilities.js");

const cache_matches = new Cacheman("matches", { ttl: "1y" });

function _update_winrate(matches) {
    matches.forEach(match => {
        match.SPRT = SPRT(match.network1_wins, match.network1_losses);
        if (match.SPRT === null) {
            match.SPRT = Math.round(100 * (2.9444389791664403 + LLR(match.network1_wins, match.network1_losses, 0, 35)) / 5.88887795833);
        }
        match.winrate = (match.network1_wins && match.network1_wins * 100 / (match.network1_wins + match.network1_losses)).toFixed(2);
    });
}

async function get_matches_from_db(db, { limit = 100, network } = {}) {
    const matches = await db.collection("matches")
        .aggregate([
            ...(network ? [{ $match: { $or: [{ network1: network }, { network2: network }] } }] : []),
            { $lookup: { localField: "network2", from: "networks", foreignField: "hash", as: "network2" } }, { $unwind: "$network2" },
            { $lookup: { localField: "network1", from: "networks", foreignField: "hash", as: "network1" } }, { $unwind: "$network1" },
            { $sort: { _id: -1 } },
            {
                $project: {
                    "network1._id": 0,
                    "network1.ip": 0,
                    "network2._id": 0,
                    "network2.ip": 0
                }
            },
            { $limit: limit }
        ]).toArray();

    matches.forEach(match => {
        match.time = match._id.getTimestamp().getTime();
    });
    _update_winrate(matches);

    return matches;
}

async function get_matches_from_cache(db, limit = 100) {
    const matches = await cache_matches.wrap("matches", () => get_matches_from_db(db));
    return matches.slice(0, limit);
}

// Win/Lose count of a match changed
async function update_matches_stats_cache(db, match_id, winner_net) {
    const matches = await get_matches_from_cache(db);
    const match = matches.find(item => item._id.toString() == match_id);
    match.game_count += 1;
    if (winner_net == 1)
        match.network1_wins += 1;
    else if (winner_net == 2)
        match.network1_losses += 1;
    _update_winrate([match]);
    cache_matches.set("matches", matches);
}

function clear_matches_cache() {
    cache_matches.clear(() => console.log("Cleared new match cache."));
}

// Get access log begin with `url`
async function get_access_logs(db, url) {
    const logs = await db.collection("logs")
        .find({
            url,
            _id: {
                $gt: objectIdFromDate(Date.now() - 24 * 60 * 60 * 7 * 1000)
            }
        })
        .sort({ _id: 1 }).toArray();
    logs.forEach(log => {
        if (!log.time) {
            log.time = log._id.getTimestamp().getTime();
        }
    });
    return logs;
}

// Count IP numbers who have sent mathc or selfplay games in the last
// timeago milliseconds
async function count_ips(db, timeago) {
    const res = await db.collection("games").aggregate([
        { $limit: 1 }, // Reduce the result set to a single document.

        { $project: { _id: 1 } }, // Strip all fields except the Id.
        { $project: { _id: 0 } }, // Strip the id. The document is now empty.

        // Lookup all collections to union together.
        { $lookup: { from: "games", as: 'games', pipeline: [
            { $match: { _id: { $gt: objectIdFromDate(Date.now() - timeago) }}},
            { $project: { ip: 1 } },
            { $group: { _id: "$ip" }}
        ]}},
        { $lookup: { from: "match_games", as: 'match_games', pipeline: [
            { $match: { _id: { $gt: objectIdFromDate(Date.now() - timeago) }}},
            { $project: { ip: 1 } },
            { $group: { _id: "$ip" }}
        ]}},

        // Merge the collections together.
        {
            $project:
            {
            Union: { $concatArrays: ["$games", "$match_games"] }
            }
        },

        { $unwind: "$Union" }, // Unwind the union collection into a result set.
        { $replaceRoot: { newRoot: "$Union" } }, // Replace the root to cleanup the resulting documents.

        { $group: { _id: "$_id" }}, // remove further duplicates between the two collection
        { $count: "ips" } // count result
    ]).toArray();
    return (res.length == 0) ? 0 : res[0].ips;
}

async function leaderboard(db, timeago = null) {
    const pipeline = timeago === null
        ? [ { $group: { _id: "$username", count: { $sum: 1 } } } ]
        : [ { $match: { _id: { $gt: objectIdFromDate(Date.now() - timeago) } } }, 
            { $group: { _id: "$username", count: { $sum: 1 } } } ];
    const index = timeago === null
        ? { username: 1 }
        : { _id: 1, username: 1 };
    const games = await Promise.all([
        db.collection("games").aggregate(pipeline).hint(index).toArray(),
        db.collection("match_games").aggregate(pipeline).hint(index).toArray()
    ]);
    let dict = new Map();
    games[0].forEach( item => {
        dict[item._id] = { username: item._id, games: item.count, match_games: 0, total_games: item.count };
    });
    games[1].forEach( item => {
        if (! (item._id in dict)) dict[item._id] = { username: item._id, games: 0 };
        dict[item._id]["match_games"] = item.count;
        dict[item._id]["total_games"] = dict[item._id]["games"] + item.count;
    });
    return dict;
};

module.exports = {
    get_matches_from_db,
    get_matches_from_cache,
    update_matches_stats_cache,
    clear_matches_cache,
    get_access_logs,
    count_ips,
    leaderboard
};
