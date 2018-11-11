function compute_win_rates (network1, network2, options_hash) {
    var n1winner = db.match_games.count({ winnerhash: network1, loserhash: network2, options_hash: options_hash });
    var n1losses =  db.match_games.count({ loserhash: network1, winnerhash: network2, options_hash: options_hash });
    return { network1_wins: n1winner, network1_losses: n1losses, game_count: n1winner + n1losses };  
}

function update_win_rates  (network1, network2, options_hash) {
    var match_count = db.matches.count( { network1: network1, network2: network2, options_hash: options_hash});
    if (matches > 1)
	throw new Error("Multiple matches with given parameters");
    else if (matches > 0) {
	var winrates = compute_win_rates (network1, network2, options_hash);
	db.matches.updateOne({ network1: network1, network2: network2, options_hash: options_hash },
			     { $set: { network1_wins: winrates.network1_wins,
				       network1_losses: winrates.network1_losses,
				       game_count: winrates.game_count }});	
    }
}

function check_symmetric_match  (network1, network2, options_hash) {
    var count = db.matches.count( { network1: network2, network2: network1, options_hash: options_hash });
    return count > 0;
}
    

function check_no_symmetric_matches() {
    var matches = db.matches.find();
    matches.forEach ( function(match) {
	if (check_symmetric_match(match.network1, match.network2, match.options_hash)) {
	    print (`${match.network1.substring(0,8)} vs ${match.network2.substring(0,8)} (hash: ${match.options_hash}) has symmetric match`)
	}
    });
}		    

function check_all_win_rates() {
    var matches = db.matches.find();
    matches.forEach ( function(match) {
	var winrates = compute_win_rates( match.network1, match.network2, match.options_hash );
	if (winrates.network1_wins != match.network1_wins ||
	    winrates.network1_losses != match.network1_losses ||
	    winrates.game_count != match.game_count) {
	    print (`${match.network1.substring(0,8)} vs ${match.network2.substring(0,8)} (hash: ${match.options_hash}) : stored ${match.network1_wins} - ${match.network1_losses}  computed: ${winrates.network1_wins} - ${winrates.network1_losses}`);
	}
    });
}

check_no_symmetric_matches();
check_all_win_rates();
