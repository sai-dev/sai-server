# leela-zero-server
## Dev Environment Setup
### Requirements
- Node.js (https://nodejs.org/en/download/)
  - Latest LTS Version should includes `npm`
- MongoDB Community Server (https://www.mongodb.com/download-center#community)
  - MongoDB Compass is optional

### Before running `node server.js`
- Ensure MongoDB is running locally on port `27017`
- Ensure dummy `auth_key` file is created at project root
- Ensure `network/best-network.gz` exists (you could download it from http://zero.sjeng.org/best-network)
- Run `npm update` to get required packages

Your project folder should look like this
```
- Project Root/
  - network/
    - best-network.gz
  - node_modules/        (generated from `npm update`)
    - ...                (bunch of packages)
  - static/
  - views/
  - auth_key             (dummy file)
  - ...                  (and other project files)
  - server.js
  
  
```

# License

The code is released under the AGPLv3 or later.

# How to run the server

First of all, install both `nodejs` and `mongodb`. The version of `nodejs` available in the Ubuntu 16.04 repositories does not work, it is probably too old. Then, follow the following steps from the root directory of the repostory:
- run `npm install`
- make a `network` directory and copy the best network file, whose name should be `best-network.gz`
- make an `auth_key` file, whose first line is the password which will be requested by the server for privileged operations
- run `mongodb < mongodb.indexes`
- start the server with `npm start`
- run `curl -F 'weights=@network/best-network.gz' -F training_count=0 -F 'key=@auth_key' http://localhost:8080/submit-network`

# Collections in the MongoDB database

## networks

- `_id`: internal identifier
- `hash`: hash value
- `ip`: IP address who submitted the network
- `training_count`: number of matches in DB when training has been computed
- `training_steps`: number of steps of training
- `game_count`: self-plays with this network
- `filters`: number of filters
- `blocks`: number of blocks
- `description`: description of the network

## games

- `_id`: internal identifier
- `sgfhash`: hash value of the sgf
- `clientversion`: version of leelaz who played this game
- `data`: training data
- `ip`: IP address who submitted the game
- `movescount`: number of moves in the SGF
. `networkhash`: hash of the network used for this game
- `randomseed`: seed used to play this game
- `sgf`: SGF of the games
- `winnercolor`: color of the winner

## matches

- `_id`: internal identifier
- `network1`: hash of the first network
- `network2`: hash of the second network (if null, it will be changed to the current best network when it is scheduled the first time)
- `network1_loses`: number of times the first network has lost a game
- `network1_wins`: number of times the first network has won a game
- `game_count`: number of playes games
- `number_to_play`: number of games to play
- `options`: a dictionary with options for leela-zero ( `resignation_percent`, `randomcnt`, `noise`, `playouts` , `visits` )
- `options_hash`: hash of the `options` dictionary

## match_games

- `_id`: internal identifier
- `sgfhash`: hash value of the sgf
- `clientversion`: version of leelaz who played this game
- `data`: training data
- `ip`: IP address who submitted the game
- `loserhash`: hash of the loser network
- `movescount`: number of moves in the SGF
- `options_hash`: hash of the options used for the match
- `score`: result of the game
- `randomseed`: seed used to play this game
- `sgf`: SGF of the games
- `winnercolor`: color of the winner
- `winnerhash`: hash of the winner network

# API and inner working

This is a very brief documentation of the web API of the server.
- `/best-network-hask`: returns two rows: the first one is the hash of the network in `network/best-network.gz`, the second one contains the number `11` (why?).
- `/best-network`: returns the best network with filename `best-network.gz`. The file is actually retrieved by the network directory, using as a name the hash of the best network with an added `.gz` extension. This was used by `autogtp` in the past, but now `autogtp` directly downloads the network from the `network` directory (which, in production, is served by `nginx`).
- `/request-match`: submit the request of a match between networks. The request is added to the `matches` collection of the MongoDB database. When `/get-task` is called, self-play tasks and match tasks are interleaved. It is a privileged API. Parameters `playouts` and `visits` cannot be used togther. If they are both omitted, a default of 3200 visits is used.
  - `network1`: hash of the first network
  - `network2`: (optional) hash of the second network. If it is not provided, the current best network is used.
  - `playouts`: number of playouts to use for the games.
  - `visits`: numbr of visits to use for the games.
  - `resignation_percent`: (optional, default 10) win probability resignation threshold
  - `noise`: (optional, default false)
  - `randomcnt`: (optional, default 0)
  - `number_to_play`: (optional, default 400) numbers of games to play
  - `key`: password for the privileged API
- `/submit-match`: submit a play corresponding to a match (i..e, a play between different networks). It may cause the current best-network to change. The play is added to the `match_games` collection. It is used by `autogtp` when a match-play is terminated.
- `/submit-network`: submit a new network. It causes a new entry with metadatas to be inserted into the `networks` collection , while the network itself is copied into the `network` directory. It is a privileged API. Parameters:
  - `weights`: gzipped file with the new network
  - `training_counts`: (optional) number of games in the DB when the training data has been exported. Default value is the number of games in the db.
  - `training_steps`: (optional) number of training steps of the network.
  - `key`: password for the privileged API
  - `description`: description of the network which is saved in the database.
- `/submit`: submit the result of a self-play. The game is added to the `games` collection, and the counter of `self-plays` for the related network is increased.  It is used by `autogtp` when a self-play is terminated.
- `/get-task/<version>`: requests a task with the given protocol version (currently ignored). The result is a json encoding the type of match (self-play vs match) and other parameters for `autogtp` and `leela-zero`. Used by `autogtp` when requesting a task.
- `/view/<hash>`: displays the SGF of the specified self-play.
- `/match-games/<matchid>`: displays the list of plays for the given match.
- `/viewmatch/<hash>`: displays the SGF of the specifietd match-play.
- `/viewmatch/<hash>.sgf`: returns the SGF of the specifietd match-play.
- `/data/elograph.json`: displays the ELO graph
- `/`: displays various statistics and general informations.

# Examples 

## Submit a network

```
curl -F 'weights=@<network-file>' -F 'training_count=0' -F 'training_steps=80000' -F 'key=<password>' -F 'description=<description>' <server-url>/submit-network
```

## Request a match

```
curl -F 'network1=<network-hash>' -F 'key=<password>'  <server-url>/request-match
```
