/*{%
	load("/okcontent/templates/common_vars.html")
	load("/okcontent/dictionaries/instantevents.dict")
	load("/okcontent/dictionaries/common_text.dict")
%}*/
// [[[
// This JS file produces two singletons of importance:
//
// InstantEvents: the system for posting and retrieving events to the websrvs
// ImUiManager* : the system for managing the botton bar UI for instant events, knowing status of chat windows, etc.
//   *In most cases InstantEvents will be making calls to ImUiManager.
//
// Starting the instant messenger is simple:
//   InstantMessenger.invoke('footer_div');  // takes destination div to build in
//
// For example, if you want to send an IM, it'll look something like this:
//   InstantEvents.send(/*info*/);
//
// Or to get a list of who's online
//   InstantEvents.checkOnline(/*users*/);
//
// Drawing calls (again, usually called by InstantMessenger) look like so:
//   ImUiManager.invoke('footer_div');
//   ImUiManager.addAChat('jenniedt');
//   ImUiManager.drawAttention('jenniedt');
//
// ]]]

var InstantEventsImplementation = Class.create({

	// CONFIG, CONSTS
	m_service_name : "/instantevents",
	m_comet_iframe_prefix_min: 1, // [[[ each window/tab has to visit its own subdomain. Start with this, numerically, prepended on the iframe_suffix (figured out below)]]]
	m_comet_iframe_prefix_max: 12, // [[[ ...and go up to this high.]]]
	m_comet_retry_if_all_prefixes_taken: 5, // [[[ seconds to retry if user has so many windows open, all subdomains taken]]]
	m_max_server_reply_time : 70, // [[[ we need to hold a prefix at least this long]]]
	m_safety_throttle_seconds : 5, // [[[ if a connection fails, don't call again in less than this time, for safety!]]]
	m_seconds_to_consider_new : 5, // [[[ if a message is message is less than this old to the server, we flash the IM window]]]
	m_seconds_to_stay_online : 1800, // [[[ if no IM sent after this long, stop pinging; we don't want left-open browsers to keep someone on overnight.]]]
	m_min_wait_after_cb_fail : 10, // [[[ if websrv is restarting or other failure,, wait at least this long before opening a new connection]]]
	m_max_wait_after_cb_fail : 30, // [[[ maximum this long]]]
	m_odds_of_posting_self_timer : 0.1, // [[[ 0..1 ]]]
	m_message_age_before_considered_archive : 3600, // [[[ a message this many seconds old will show up, potentially, but be grayed, from their old conversation]]]
	m_emergency_reopen_every : 40000, // This has to be greater than the server-side response time or we'll reopen shit for the wrong reasons
	m_emergency_reopen_timeout: null,
	
	// VARS
	m_optional_params : {},
	m_is_a_popup : false,		// [[[ InstantEvents can be instantiated in a page just designed to deal with one partner screenname ]]]
	m_partner_screenname : "",  // [[[ If a popup, the screenname of the partner dealt with ]]]
	m_script_obj_id : "instant_events_script_" + Math.random(),
	m_comet_iframe_prefix : -1, // a number from the ranges specified above; will be prepended on suffix to build domain
	m_script_obj : null, // the script object we add to the page
	m_destination_div : false,
	m_last_connection : false,
	m_comet_iframe_suffix : "", // NOW SET BELOW. e.g. ".craig.dev.okcupid.com:2000/instantevents/instantevents_iframe.html",
	m_last_server_gmt_sync : 0,
	m_last_server_seqid_sync : 0,
	m_last_user_activity : 0, // the last time the user sent a message or did something to show they didn't leave window open
	m_pending_online_checks : [ ],
	m_has_done_initial_online_checks : false,	
	m_send_timing_queue : {}, // we'll keep a queue of send times, and on callbacks make another ajax call to post how long it took
	m_active : true, // TJ: This determines whether or not we get instant events
	m_im_active : false, // TJ: used for display of IM being on or off, use sookies on invoke
	m_has_had_emergency_restart : false,
	m_is_first_e_r_attempt : true,
	m_num_throttle_hits : 0,
	m_is_transition : false,
	
	// for debuggung
	m_last_json_replies : [],
	
	// METHODS
	invoke : function(destination_div, optional_params) {

		// user wants to start IM off.
		if (optional_params.off)
		{
			if (optional_params.im_off == 0) {
				this.m_is_transition = true;
				util.updateStats("instant events - sookie set to disabled but IM is still on",
					1, "counter", "7XfhT3pu5O8p6qEJC7ht0AuFz6M=");
			}
			this.m_im_active = false;
		}
		else
			this.m_im_active = true;
		if (optional_params) {
			this.m_optional_params = optional_params;
		}
		if (this.m_optional_params["popup"] && this.m_optional_params["partner_screenname"]) {
			this.m_is_a_popup = true;
			this.m_partner_screenname = this.m_optional_params["partner_screenname"];
			document.title = this.m_optional_params["partner_screenname"] + ': Chat on OkCupid.com';
		}
		var i = 0;
		this.setCometIFrameSuffix();
		this.m_last_user_activity = new Date();
		this.m_destination_div = destination_div;
		ImUiManager.invoke(destination_div, this.m_optional_params);
		EventUiManager.invoke(destination_div, this.m_optional_params);
		if (this.m_is_transition) {
			this.m_im_active = true;
			this.deactivateIM();
		}
		// If IM is on, or if this window is a popup, activate InstantEvents
		if (this.m_active || this.m_is_a_popup) {
			this.performOnlineCheckNow();
			this.openConnection(true, false);
			if (this.m_is_a_popup)
				this.openAnImWindow(this.m_partner_screenname, optional_params);
		}
	},
	setCometIFrameSuffix : function() {
		if (window.location.port == 2000) {
			this.m_comet_iframe_suffix = ".%{HTTP_HEADER_HOST}/instantevents";
		}
		else if (window.location.port == 900) {
			this.m_comet_iframe_suffix = ".instant.okcupid.com:900/instantevents";
		}
		else {
			this.m_comet_iframe_suffix = ".instant.okcupid.com/instantevents";
		}
	},
	getAPrefixLock : function() {
		this.m_comet_iframe_prefix = -1;
		var i =  this.m_comet_iframe_prefix_min - 1;
		while (this.m_comet_iframe_prefix == -1 && i < this.m_comet_iframe_prefix_max) {
			i++;
			var x = NanoCookie.get('iframe_prefix_lock_' + i);
			if (! x) {
				NanoCookie.set('iframe_prefix_lock_' + i, '1', {ms : 1000*this.m_max_server_reply_time});
				this.m_comet_iframe_prefix = i;
			}
		}
	},
	clearPrefixLock : function() {
		NanoCookie.set('iframe_prefix_lock_' + this.m_comet_iframe_prefix,"1",{ms : 1000});
		this.m_comet_iframe_prefix = -1;
	},
	openConnection : function(is_initial, bypass_throttle) {
	    
		if (this.m_active) {
			var d = new Date();
			var time_left = this.m_safety_throttle_seconds * 1000 - (d - this.m_last_connection);
			if (this.secondsSinceLastUserActivity() > this.m_seconds_to_stay_online) {
				if (this.m_emergency_reopen_timeout) {
					clearTimeout(this.m_emergency_reopen_timeout);
					this.m_is_first_e_r_attempt = false;
				}
				setTimeout("InstantEvents.openConnection(false,false);", 2000);
				return;
			}
			if (time_left > 0 && ! bypass_throttle) {
				this.m_num_throttle_hits++;
			    util.updateStats("instant - ui - throttle hit", 1, "counter", "keqxuxeCzuhEO6X8szEnkyi284s=");
				if (this.m_has_had_emergency_restart) 
					util.updateStats("instant - ui - throttle hit after e.r.", 1, "counter", "IRLVMdV/VQinEH6jk1smZQO6VkA=");
				if (this.m_num_throttle_hits == 1)
					util.updateStats("instant - ui - throttle hit - count 1", 1, "counter", "ZotCHsSXQiZZ8mUAdr58G4h/Y48=");
				if (this.m_num_throttle_hits == 2)
					util.updateStats("instant - ui - throttle hit - count 2", 1, "counter", "bLzNmKpeN6Qv5uUbzFEEh51HmXc=");
				if (this.m_num_throttle_hits == 3)
					util.updateStats("instant - ui - throttle hit - count 3", 1, "counter", "6U/aosnJnIG44QFzV8ZeuPv99B4=");
				if (this.m_num_throttle_hits == 4)
					util.updateStats("instant - ui - throttle hit - count 4", 1, "counter", "wyI6ToCdffIFnSmybPen53OcwA4=");
				if (this.m_num_throttle_hits == 5)
					util.updateStats("instant - ui - throttle hit - count 5", 1, "counter", "gYGA+DcFGvrcaiI3HHT5Lo11MCE=");
				if (this.m_num_throttle_hits == 10)
					util.updateStats("instant - ui - throttle hit - count 10", 1, "counter", "5CiIfAzkUMsCMTr2W5lQ4iSVwXY=");
				setTimeout("InstantEvents.openConnection(false,false);", time_left + 250);
				return;
			}
			this.getAPrefixLock(); // figure out a subdomain to use
			if (this.m_comet_iframe_prefix == -1) {
				setTimeout("InstantEvents.openConnection(false,false);", this.m_comet_retry_if_all_prefixes_taken*1000);
				if (this.m_emergency_reopen_timeout) {
					clearTimeout(this.m_emergency_reopen_timeout);
					this.m_is_first_e_r_attempt = false;
				}
				return;
			}
			this.m_last_connection = new Date();
			// [[[ make sure a connection is still open in a minute or so ]]]
			if (this.m_emergency_reopen_timeout) {
				clearTimeout(this.m_emergency_reopen_timeout);
				this.m_is_first_e_r_attempt = false;
			}
			this.m_emergency_reopen_timeout = setTimeout("InstantEvents.emergencyReopenConnection();", this.m_emergency_reopen_every);

			// MK 2011/3/17 -- specify document.location.protocol so that pages that are requested over SSL also request
			// instantevents over SSL.
			var final_src = document.location.protocol + '//' + this.m_comet_iframe_prefix + this.m_comet_iframe_suffix + '?random='+Math.random(); 
	
			if (! is_initial) {
				final_src += "&server_seqid=" + this.m_last_server_seqid_sync;
				final_src += "&server_gmt=" + this.m_last_server_gmt_sync;
				// We need to guarantee shutdown JS in the iframe has to run.  Will only take a couple milliseconds, but there's no rush in DOM removal.
				setTimeout('document.body.removeChild($("' + this.m_script_obj_id + '"));', 2000);
			}
			this.m_script_obj_id = 'instant_events_script_' + Math.random();
			this.m_script_obj = IFrameInsertedAt(document.body);
			this.m_script_obj.setAttribute("id", this.m_script_obj_id);
			this.m_script_tag = this.m_script_obj.doc.createElement("script");
			this.m_script_tag.src= final_src;
			this.m_script_tag.type = "text/javascript";
			setTimeout("InstantEvents.m_script_obj.doc.body.appendChild(InstantEvents.m_script_tag)",500);
			$(this.m_script_obj_id).style.display="none";
		}
	    
	},
	// [[[
    // Normally a new connection is spawned from the cb of a previous one. But what if there's an
	// error of some kind?  Or a dropped connection?  so this is called 65ish seconds after any
	// connection open. But it shouldn't get called because every new connection keeps pushing back
	// the call to this
	// ]]]

	emergencyReopenConnection : function() {
        var d = new Date();
		util.updateStats("instant - ui - emergency restart", 1, "counter", "GZPpF7XECZ2Kv9Vz1sVeN2GcwGg=");
		if (this.m_is_first_e_r_attempt) 
			util.updateStats("instant - ui - emergency restart - on first", 1, "counter", "yp1SFIPrKRjS1W9qXkQHTZjSCuI=");

		new Ajax.Request("/why", {method : "get", parameters : { "instanteventswatch" : 1, 
                                                                 "openconnections" : NanoCookie.findRegExp(/iframe_prefix_lock_.*/).length,
                                                                 "reqtime" : d.getTime() / 1000
                                                               } });
		this.m_has_had_emergency_restart = true;
		this.openConnection(false, true);
	},
	
	recordResponseForDebugging : function(response) {
		var r_json = Object.toJSON(response);
		this.m_last_json_replies.push(r_json);
		if (this.m_last_json_replies.length > 5)
			this.m_last_json_replies = this.m_last_json_replies.splice(1, this.m_last_json_replies.length - 1);
	},
	// [[[
	// This is not called back by a normal AJAX reply. It's called directly with the response (eval'ed JSON) and responseText (just the text not eval'ed)
	// from the iframe, when it gets a reply.
	// ]]]
	openConnection_cb : function(response) {		
		
		//this.recordResponseForDebugging(response);

		this.clearPrefixLock();
		if (response.server_gmt) {
			this.m_last_server_gmt_sync = response.server_gmt;			
		}
		if (response.server_seqid && response.server_seqid > 0) {
			this.m_last_server_seqid_sync = response.server_seqid;
		}

		// [[[
		// In case a call comes back after they've turned it off.
		// ]]]
		if (! this.m_active)
			return;
		
		
		
		if (response.events && response.events.length) {
			// [[[ Restarting the connection has to be in a random time 
		    // for IE race condition when multiple windows both get IM's and try 
			// to open new connections at the same ms.]]]
			setTimeout("InstantEvents.openConnection(false,true)",Math.random()*1000);
			
			for (var i = 0; i < response.events.length; i++) {
				if (response.events[i].type == "im") {
					var partner_screenname;
					if (response.events[i].from)
						partner_screenname = response.events[i].from;
					else
						partner_screenname = response.events[i].to;
					// [[[Only deal with the message if this is a general Instant Events interface (not a popup) or it matches the popup screenname ]]]
					if (! this.m_is_a_popup || partner_screenname.toLowerCase() == this.m_partner_screenname.toLowerCase()) {
						if (! ImUiManager.m_open_chats[partner_screenname.toLowerCase()]) {
							for (var j = 0; j < response.people.length; j++) {
								if (response.people[j].screenname.toLowerCase() == partner_screenname.toLowerCase()) {
									ImUiManager.addAnOpeningMessage(response.people[j],{topic:response.events[i].topic});
								}
							}
						}
						ImUiManager.addAMessage(response.events[i], this.m_last_server_gmt_sync - response.events[i].server_gmt);
					}
					
				// [[[	This if isn't really necessary, since once you turn off non-IM events, the iframes append the param "types=im",
				//		preventing any non-IM messages from being sent to the user anyway ]]]
				} else if (EventUiManager.m_display_events) {
					for (var j = 0; j < response.people.length; j++) {
						var people_from = response.people[j].screenname.toLowerCase();
						var events_from = response.events[i].from.toLowerCase();
						if (people_from == events_from) {
							if (
								// [[[ If ((event is an old orbit logout || event is a new orbit logout) && event is from someone we're not chatting with) ]]]
								((response.events[i].type == "orbit" && response.events[i].event_id == "11" || response.events[i].type == "orbit_user_signoff") && !(ImUiManager.m_open_chats[events_from])) ||
								
								// [[[ Or this user is un-IMable ]]]
								(response.people[j].im_ok != 1)
								) {
								// [[[ Do nothing ]]]
								// [[[ The "old orbit" cases above can be removed after the new orbit types are live.  This temporary code handles both cases. ]]]
							}
							else {
								EventUiManager.update(response.people[j], response.events[i]);
								break;
							}
						}
					}
				}
			}
			if (response.people) {
				for (var i = 0; i < response.people.length; i++) {
					if (! this.m_is_a_popup || response.people[i].screenname.toLowerCase() == this.m_partner_screenname.toLowerCase()) {
						ImUiManager.maintainScrollTop(response.people[i].screenname);
					}
				}
			}
		}
		else if (response.not_logged_in) {
			this.m_active = false;
		}
		else if (this.m_active) {
			// [[[ Restarting the connection has to be in a random time for IE race condition when multiple windows both get IM's and try to open new connections at the same ms.]]]
			setTimeout("InstantEvents.openConnection(false,false)",Math.random()*1000);		
		}
	},
	endConnections : function() {
		this.clearPrefixLock();
	},
	openAnImWindow : function(partner_screenname, optional_params) {
		InstantEvents.activateIM ();
		var already_open = false;
		optional_params = optional_params || {};
		if (ImUiManager.m_open_chats[partner_screenname.toLowerCase()]) {
			already_open = true;
		}
		optional_params.set_state = "expanded";
		ImUiManager.addAChat(partner_screenname, optional_params);
		if (! already_open) {
			ImUiManager.getUserInfoForNewIm(partner_screenname);
		}
	},
	sendAnIm : function(partner_screenname, msg, topic) {
		var random_id = Math.round(Math.random()*2000000000);
		var strategy = 2;//Math.floor(Math.random() * 2) + 1;
		this.updateLastUserActivity();

		// TJ: Fix the bug where the IM bar would remain off even while
		// sending messages
		this.activateIM ();
		ImUiManager.loseAttention(partner_screenname);
		this.m_send_timing_queue[random_id] = new Date();
		new Ajax.Request(this.m_service_name, {
					 method: "post",
					 parameters: { 
						send : 1, 
						attempt: 1, 
						rid: random_id, 
						recipient : partner_screenname, 
						topic : topic || false,
						body : msg, 
						rand : Math.random() 
					 },
					 onSuccess: InstantEvents.sendAnIm_cb.bindAsEventListener(this,partner_screenname, random_id, 1, strategy),
					 onFailure: InstantEvents.sendAnIm_cb_fail.bindAsEventListener(this)
					 });
		if (strategy == 2) {
			setTimeout(this.sendAnImCopy.bind(this,partner_screenname,msg,random_id, strategy),1000);
		}
	},
	//
	// If the first one hasn't come back yet send a second, so hopefully one gets through.
	//
	sendAnImCopy : function(partner_screenname, msg, random_id, strategy) {
		// If there's still something in the timing queue, the other hasn't returned
		if (this.m_send_timing_queue[random_id]) {
			new Ajax.Request(this.m_service_name, {
						 method: "post",
						 parameters: { send : 1, attempt: 2, rid: random_id, recipient : partner_screenname, body : msg, rand : Math.random() },
						 onSuccess: InstantEvents.sendAnIm_cb.bindAsEventListener(this,partner_screenname, random_id, 2, strategy),
						 onFailure: InstantEvents.sendAnIm_cb_fail.bindAsEventListener(this)
						 });
		}
	},
	sendAnIm_cb : function(transport, partner_screenname, random_id, attempt, strategy) {
		// figure out how long since send attempt and post that over AJAX
		if (this.m_send_timing_queue[random_id]) {
			var send_time = this.m_send_timing_queue[random_id];
			this.m_send_timing_queue[random_id] = null;
			var d = new Date();
			var ms = d.getTime() - send_time.getTime();
			if (Math.random() < this.m_odds_of_posting_self_timer) {
				new Ajax.Request(this.m_service_name, {
							 	method: "get",
								parameters: { self_timer : 1, milliseconds : ms, attempt : attempt, strategy : strategy}
								 });
			}
		}
		var response = transport.responseText.evalJSON();
		if (response.message_sent != 1 || response.reason == 'nag') {
		    var key_pass = {p_screenname:partner_screenname}
			switch (response.reason) {
				case "recip_not_online":
					ImUiManager.addASystemMessage(partner_screenname, util.jogf('%{IE_USER_WENT_OFFLINE}',key_pass));
					break;
				case "im_not_ok":
					ImUiManager.addASystemMessage(partner_screenname, util.jogf('%{IE_USER_IM_NOT_OK}',key_pass));
					break;
				case "im_self":
					ImUiManager.addASystemMessage(partner_screenname, util.jogf('%{IE_USER_IM_SELF}',key_pass));
					break;
				case "recip_im_off":
					ImUiManager.addASystemMessage(partner_screenname, util.jogf('%{IE_USER_IM_OFF}',key_pass));
					break;
				case "nag":
					ImUiManager.addAStaffRobotMessage(partner_screenname, 'nag');
					break;
			}
		}
	},
	sendAnIm_cb_fail : function(transport) {
		alert('%{IE_SEND_FAILED}');
	},
	// [[[ checkOnline(params):
	//
	// If called before page load, it queues up, and later calls all of them at once
	// collected across the page. So there's only one ajax call, even if you have
	// 20 buttons around the page.
	//
	// If you call this after the page has loaded, for example, if you need to look up
	// someone's online info after the fact, it will execute immediately.
	//
	// How versatile.
	//
	// Params:
	//
	// 1. At least one of:
	//    a. username
	//    b. userid
	// 2. A subset of:
	//    a. cb : a function to call with the data about the user
	//    c. show : id to display:; if user is online
	//    b. hide : id to display:none; if user is online
	//	
	// Example: InstantEvents.checkOnline({ username : 'jennieDT', show : 'im_jennieDT' });
	// Example: InstantEvents.checkOnline({ username : 'jennieDT', cb : function(response){ if (response.im_ok) alert(" you can IM her!") } })'
	//
	// Multiple online checks for the same user can happen on a page before pageload; all of the collective shows, hides, and cb's will be performed.
	// This makes sense since the user might be in a match result and in your favorites list, for example.
	//
	//
	//]]]
	checkOnline : function(params) {
		var key;
		this.m_pending_online_checks.push(params);
		if (this.m_has_done_initial_online_checks) {
			this.performOnlineCheckNow();
		}
	},	
	performOnlineCheckNow : function() {
		this.m_has_done_initial_online_checks = true;
		if (this.m_pending_online_checks.length == 0) {
			return;
		}
		var params = {is_online : 1, rand : Math.random()};
		var added_already = { } ;
		var username_list = "";
		var userid_list = "";
		for (var i = 0; i < this.m_pending_online_checks.length; i++) {
			var check = this.m_pending_online_checks[i];
			if (check.username && ! added_already[check.username]) {
				if (username_list != "")
					username_list += ",";
				username_list += check.username;
				added_already[check.username] = true;
			}
			else if (check.userid && ! added_already[check.userid]) {
				if (userid_list != "")
					userid_list += ","
				userid_list += check.userid;
				added_already[check.userid] = true;				
			}
		}
		if (username_list != "")
			params["usernames"] = username_list;
		if (userid_list != "")
			params["userids"] = userid_list;
		new Ajax.Request(this.m_service_name, {
				 method: "post",
				 parameters: params,
				 onSuccess: InstantEvents.performOnlineCheck_cb.bindAsEventListener(this),
				 onFailure: InstantEvents.performOnlineCheck_cb_fail.bindAsEventListener(this)
		 });
	},
	performOnlineCheck_cb : function(transport) {
		var result = transport.responseText.evalJSON();
		for (var j = 0; j < this.m_pending_online_checks.length; j++) {
			found_yet = false;
			var check = this.m_pending_online_checks[j];
			// TODO: n^2 to be fixed later but no big deal on this size anyway.
			for (var i = 0; i < result.length && ! found_yet; i++) {
				if ((check.username && check.username.toLowerCase() == result[i].screenname.toLowerCase()) || (check.userid == result[i].userid)) {
					found_yet = true;
					if (result[i].open_connection) { // [[[ TODO: REPLACE THIS WITH im_ok INSTEAD OF open_connection ]]]
						if (check.hide) {
							$(check.hide).style.display = "none";
						}
						if (check.show) {
							$(check.show).style.display = "";
						}
					}
					if (check.cb) {
						check.cb(result[i]);
					}
				}
			}
			if (found_yet == false) {
				check.cb({screenname : check.username.toLowerCase(), userid : check.userid, open_connection : false, im_ok : false, im_not_ok : true});
			}
		}	
		this.m_pending_online_checks = [];
	},
	blockImAjax: function(screenname) {
		new Ajax.Request(this.m_service_name, {
				 method: "get",
				 parameters: {im_block : 1, target_screenname : screenname} });
	},
	performOnlineCheck_cb_fail : function() {
		alert("Failed to check online.");
	},
	updateLastUserActivity : function() {
		this.m_last_user_activity = new Date();
	},
	secondsSinceLastUserActivity : function() {
		var d = new Date();
		return (d.getTime() - this.m_last_user_activity.getTime())/1000;
	},
	setOffSookie : function() {
		AjaxSookie.set("ie_off", true, 86400*180, "5ce7070491ce759bc567f423e986ce5c97130e7b");
	},
	clearOffSookie : function() {
		AjaxSookie.clear("ie_off");
	},
	activate : function () {
		if (!this.m_active) {
			this.m_active = true;
			this.performOnlineCheckNow();
			this.openConnection(false, false);
		}
	},
	deactivate : function () {
		if (this.m_active) {
			this.m_active = false;

			this.endConnections();
			deactivateIM ();
		}
	},
	activateIM : function () {
		if (!this.m_im_active) {
			this.clearOffSookie();
			new Ajax.Request("/instantevents", {
				parameters : {
					turn_im_on : 1
				}
			});
			this.m_im_active = true;

			$('im_prefs').removeClassName('inactive');
			this.activate ()
		}
	},
	deactivateIM : function () {
		if (this.m_im_active) {
			this.m_im_active = false;
			this.setOffSookie();
			new Ajax.Request("/instantevents", {
				parameters : {
					turn_im_off : 1
				}
			});

			$('im_prefs').addClassName('inactive');
		}
	},
	toggle : function () {
		this.m_im_active ? this.deactivateIM() : this.activateIM();
		if ($("display_messaging_on")) {
			$("display_messaging_on").style.display = this.m_im_active ? "" : "none";
			$("display_messaging_off").style.display = this.m_im_active ? "none" : "";
		}		
	}
});

var ImUiManagerImplementation = Class.create({
	m_optional_params : {},
	m_is_a_popup : false,
	m_partner_screenname : "",				 
	m_service_name : "/instantevents",
	m_open_chats : {},
	m_destination_div : false,
	m_window_flashing_message : "",
	m_window_flashing_rate : 400,
	m_window_flashing_interval : null,
	m_original_document_title : "",
	m_new_im_flashing : false,
	m_close_action : function() {}, // what to do when this window closes; nothing likely unless it's a popup
	invoke : function(destination_div, optional_params) {
		this.m_optional_params = optional_params;		
		this.m_destination_div = destination_div;
		if (this.m_optional_params["popup"] && this.m_optional_params["partner_screenname"]) {
			this.m_is_a_popup = true;
			this.m_partner_screenname = this.m_optional_params["partner_screenname"];
			// What to do when the window is closed. Catching closes of popups allows us to notify other windows, via cookie sets, to take new state actions.
			Event.observe(window, "beforeunload", this.m_close_action);
		}
		else {
			setInterval("ImUiManager.watchForPopouts()",1000);
		}
		this.createPreferencesTab();
	},
	updatePreferencesPane: function(html) {
		$('im_settings_text').innerHTML = html;
	},
	numVisibleChats: function() {
		var res = 0;
		for (chat in this.m_open_chats) {
			if (this.m_open_chats[chat].m_state != "hidden") {
				res++;
			}
		}
		return res;
	},
	proposeBlock: function(screenname) {
		var html = '<p>' + util.jogf('%{IE_SURE_TO_BLOCK}',{screen_name:screenname});
		html += '%{IE_SURE_TO_BLOCK_2}'
			 +  '</p>'
			 +  ' <ul>'
			 +  '   <li><a href="#" onclick="ImUiManager.doBlock(\''+screenname+'\',true); return false;">%{IE_SURE_TO_BLOCK_YES}</a></li>'
			 +  '   <li><a href="#" onclick="ImUiManager.doBlock(\''+screenname+'\',false); return false;">%{IE_SURE_TO_BLOCK_NO}</a></li>'
			 +  ' </ul>';
		this.updatePreferencesPane(html);			
	},
	doBlock: function(screenname, do_it) {
		var html = "";
		if (do_it) {
		    var pass_name = this.m_partner_screenname;
			html += '<p>' + util.jogf('%{IE_BLOCK_DONE}',{p_screenname:pass_name}) + '</p>';
			InstantEvents.blockImAjax(screenname);
			this.hideChat(screenname);
		}
		else {
			html += "<p><strong>%{IE_DISASTER_AVERTED}</strong><br /><br />%{IE_DISASTER_AVERTED_MORE}</p>";
		}
		this.updatePreferencesPane(html);
	},
	doImBlock: function(partner_screenname, do_it) {
		if(this.m_open_chats[partner_screenname.toLowerCase()]) {
			this.m_open_chats[partner_screenname.toLowerCase()].doBlock(true);
		}
	},
	createPreferencesTab: function() {
		var im_state = InstantEvents.m_im_active ? '' : ' inactive';
		var html =	'<div class="im_prefs_tab' + im_state + '" id="im_prefs">'
			+		'	<a href="#" class="gears" title="%{IE_BUTTON_SETTINGS}" onClick="ImUiManager.togglePreferences(); return false;"></a>'
			+		'	<a href="#" class="chat" title="%{IE_BUTTON_IM_SOMEONE}" onClick="ImUiManager.toggleNewIm(); return false;"></a>'
			+		'</div>';
		Element.insert(this.m_destination_div, {"bottom" : html});
	},
	togglePreferences: function() {
		if ($('settings_container') && $('settings_container').style.display != 'none') {
			$('settings_container').style.display = 'none';
		}
		else {
			var screens = this.getActiveScreenNames();
			if (!$('settings_container')) {
				var html = ''
					+	'<div id="settings_container">'
					+   '	<div id="im_settings">'
				    +   '   	<div class="im_settings_cap"></div>'
					+   '    	<div id="im_settings_body">'
					+   '        	<div class="im_settings_tab">'
					+	'	         	<a href="#" class="im_option close_prefs" title="%{IE_BUTTON_CLOSE}" onClick="ImUiManager.togglePreferences(); return false;"></a>'
					+   '            	Instant Messages'
					+   '        	</div>'
					+   '        	<div id="im_settings_text"></div>'
					+   '        	<a href="#" class="im_action done" onClick="ImUiManager.togglePreferences(); return false;">%{IE_BUTTON_DONE}</a>'
					+   '    	</div>'
					+   '	</div>'
					+	'</div>';
				Element.insert("im_prefs", {"before": html});
			}
			var html = '';
			if (screens.length > 0) {
				html += '<p class="title">Block</p>'
					+   '<ul>';
				for (var i = 0; i < screens.length; i++) {
					html += '<li><a href="#" onclick="ImUiManager.proposeBlock(\'' + screens[i] + '\'); return false;">Ignore ' + screens[i] + '</a></li>';
				}
				html += '</ul>';
			}
			var display_events_on = EventUiManager.m_display_events ? '' : 'display: none;';
			var display_events_off = EventUiManager.m_display_events ? 'display: none;' : '';
			var display_messaging_on = InstantEvents.m_im_active ? '' : 'display: none;';
			var display_messaging_off = InstantEvents.m_im_active ? 'display: none;' : '';
			
			html += ''
				+	'<p class="title">%{IE_MESSAGING_SETTINGS}</p>'
				+	'<p><a href="#" onClick="InstantEvents.toggle();ImUiManager.togglePreferences(); return false;">'
				+	'	<span id="display_messaging_on" style="' + display_messaging_on + '">%{IE_ON}</span>'
				+	'	<span id="display_messaging_off" style="' + display_messaging_off + '">%{IE_OFF}</span>'
				+	'</a></p>'
				+	'<p class="title">%{IE_EVENTS_SETTINGS}</p>'
				+	'<p><a href="#" onClick="EventUiManager.toggleEvents(); return false;">'
				+	'	<span id="display_events_on" style="' + display_events_on + '">%{IE_ON}</span>'
				+	'	<span id="display_events_off" style="' + display_events_off + '">%{IE_OFF}</span>'
				+	'</a></p>'
				+   '<p class="title">%{IE_RELATED_LINKS}</p>'
				+   '   <p><a href="/imhistory">%{IE_MY_CHAT_HISTORY}</a></p>'
				+	'';
			$('im_settings_text').innerHTML = html;
			$('settings_container').style.display = "";
		}	
	},

	acceptMessagingTurnOff: function() {
		$('im_settings_text').innerHTML = '<p>Closing down connections!</p>'
		InstantEvents.toggle();ImUiManager.togglePreferences();
	},
	// -------------------------------------

	toggleNewIm: function() {
		if ($('new_im') && $('new_im').style.display != 'none') {
			$('new_im').remove();
		}
		else {
			InstantEvents.activateIM ();
			var html = '<div id="new_im">';
			html +=    '	<div class="new_im_cap"></div>'
				+	   '	<div class="new_im_body">'
				+	   '		<a href="#" onclick="ImUiManager.tryNewIm();return false;">GO</a>'
				+	   '		<input type="text" id="target_user" value="%{IE_ENTER_USERNAME}" onFocus="ImUiManager.newImFocus();" onBlur="ImUiManager.newImBlur();" />'
				+	   '	</div>'
				+      '</div>';
			Element.insert(this.m_destination_div, {"top" : html});
			$('target_user').observe("keyup", ImUiManager.catchKeyStroke.bindAsEventListener(ImUiManager, false));
		}
	},
	tryNewIm: function() {
		// [[[ Strip trailing/leading whitespace ]]]
		var target_user = $F('target_user').replace(/^\s+/,'').replace(/\s+$/,'');
		if (target_user == '%{IE_ENTER_USERNAME}') {
			$('target_user').pulsate({pulses:2, duration:0.8});
		}
		else {
			InstantEvents.checkOnline({ 
				username : target_user,
				cb : function(response) {
					optional_params = {};
					if (response.topic) {
						optional_params.topic = response.topic;
					}
						
					if (response.im_not_ok) {
						$('target_user').value = '%{IE_NO_SUCH_USER}';
						$('target_user').blur();
						$('target_user').pulsate({pulses:2, duration:0.8});
						this.m_new_im_flashing = true;
						setTimeout("if ($F('target_user') == \"User doesn't exist\") {$('target_user').value = '%{IE_ENTER_USERNAME}';}", 2000)
					}
					else {
						var target_user = $F('target_user').replace(/^\s+/,'').replace(/\s+$/,'');
						InstantEvents.openAnImWindow(target_user,optional_params);
						ImUiManager.toggleNewIm();
					}
				}
			});
		}
	},
	newImFocus: function() {
		if ($F('target_user') == '%{IE_ENTER_USERNAME}' || $F('target_user') == "%{IE_NO_SUCH_USER}") {
			$('target_user').value = '';
		}
	},
	newImBlur: function() {
		if ($F('target_user') == '') {
			$('target_user').value = '%{IE_ENTER_USERNAME}';
		}
	},
	getActiveScreenNames: function() {
		var res = new Array();
		for (chat in this.m_open_chats) {
			res.push(this.m_open_chats[chat].m_partner_screenname);
		}
		return res;
	},
	//
	// optional_params
	//   set_state : "expanded"|"collapsed|hidden" -- set the window state
	//
	addAChat: function(partner_screenname, optional_params) {
		this.addAChatIfMissing(partner_screenname, optional_params);
		if (optional_params && optional_params.set_state) {
			this.m_open_chats[partner_screenname.toLowerCase()].setState(optional_params.set_state);
		}
		this.adjustWindowWidths();
	},
	addAChatIfMissing: function(partner_screenname, optional_params) {
		if (! this.m_open_chats[partner_screenname.toLowerCase()]) {
			this.m_open_chats[partner_screenname.toLowerCase()] = new ImWindow(this.m_destination_div, partner_screenname, optional_params);
		}
		this.adjustWindowWidths();
	},
	removeAChat: function(partner_screenname) {
		if (this.m_open_chats[partner_screenname.toLowerCase()]) {
			this.m_open_chats[partner_screenname.toLowerCase()].unDraw();
			this.m_open_chats[partner_screenname.toLowerCase()] = false;
		}
	},
	maintainScrollTop : function(partner_screenname) {
		var screen_lower = partner_screenname.toLowerCase();
		if (this.m_open_chats[screen_lower]) {
			this.m_open_chats[screen_lower].maintainScrollTop();
		}
	},
	getUserInfoForNewIm : function(partner_screenname) {
		new Ajax.Request("/userinfo", {
				 method: "get",
				 parameters: { u : partner_screenname, thumb: true },
				 onSuccess: ImUiManager.getUserInfoForNewIm_cb.bindAsEventListener(this)
						 });
	},
	getUserInfoForNewIm_cb : function(transport) {
		var info = transport.responseText.evalJSON();
    info.screenname = info.target;
		ImUiManager.addAnOpeningMessage(info);
	},
	addAnOpeningMessage : function(im_person, optional_params) {
		this.addAChatIfMissing(im_person.screenname, optional_params);
		this.m_open_chats[im_person.screenname.toLowerCase()].addAnOpeningMessage(im_person,optional_params);
		this.adjustWindowWidths();
	},
	addAMessage : function(im_event, message_age_in_seconds) {

		var partner_screenname = im_event.to ? im_event.to : im_event.from;
		var c = NanoCookie.get("im_state_" + partner_screenname.toLowerCase());
		this.addAChatIfMissing(partner_screenname,{topic:im_event.contents.topic});
		//this.m_open_chats[partner_screenname.toLowerCase()].addAMessage(im_event.contents, im_event.to ? true : false, message_age_in_seconds);
		this.m_open_chats[partner_screenname.toLowerCase()].addAMessage(im_event.contents, im_event.to ? true : false, im_event.server_gmt);
		if (im_event.from && message_age_in_seconds < InstantEvents.m_seconds_to_consider_new) {
			//if (! this.m_is_a_popup && this.m_open_chats[partner_screenname.toLowerCase()].state != "popped") {
			if (! this.m_is_a_popup && c && c != "popped") {
				this.drawAttention(partner_screenname,{topic:im_event.topic});
			}
			else if (this.m_is_a_popup && this.m_partner_screenname.toLowerCase() == partner_screenname.toLowerCase()) {
				window.focus();
			}
		}
		if (message_age_in_seconds < InstantEvents.m_seconds_to_consider_new)
			this.adjustWindowWidths();
	},
	addASystemMessage : function(partner_screenname, text) {
		this.addAChatIfMissing(partner_screenname);
		this.m_open_chats[partner_screenname.toLowerCase()].addASystemMessage(text);
	},
	addAStaffRobotMessage : function(partner_screenname, text) {
		this.addAChatIfMissing(partner_screenname);
		this.m_open_chats[partner_screenname.toLowerCase()].addAStaffRobotMessage(text);
	},
	startFlashingWindow : function(message) {	
		if (this.m_original_document_title == "") {
			this.m_original_document_title = document.title;
		}
		this.stopFlashingWindow(false);
		document.title = message;
		this.m_window_flashing_interval = setInterval(this.flashingWindowLoop.bindAsEventListener(this), this.m_window_flashing_rate);
	},
	stopFlashingWindow : function(notify_others) {
		if (this.m_window_flashing_interval) {
			clearInterval(this.m_window_flashing_interval);
		}
		this.m_window_flashing_interval = null;
		if (this.m_original_document_title != "") {
			document.title = this.m_original_document_title;
		}
		if (notify_others) {
			NanoCookie.set("stop_flashing", "1", {ms : 3000});
		}
	},
	flashingWindowLoop : function() {
		document.title = document.title.substr(1) + document.title.charAt(0);
		var x = NanoCookie.get("stop_flashing");
		if (x) {
			this.stopFlashingWindow(false);
		}
	},
	drawAttention : function(partner_screenname) {
		this.addAChatIfMissing(partner_screenname);
		this.m_open_chats[partner_screenname.toLowerCase()].drawAttention();
		this.startFlashingWindow("---IM-from--" + partner_screenname);
	},
	flashAttention : function(partner_screenname) {
		this.m_open_chats[partner_screenname.toLowerCase()].flashAttention();
	},
	loseAttention : function(partner_screenname) {
		this.m_open_chats[partner_screenname.toLowerCase()].loseAttention();
		this.stopFlashingWindow(true);
	},
	expandChat : function(partner_screenname) {
		this.addAChatIfMissing(partner_screenname);
		this.m_open_chats[partner_screenname.toLowerCase()].expand();
		this.maintainScrollTop(partner_screenname);
	},
	collapseChat : function(partner_screenname) {
		this.addAChatIfMissing(partner_screenname);
		this.m_open_chats[partner_screenname.toLowerCase()].collapse();
	},
	hideChat : function(partner_screenname) {
		new Ajax.Request(
			"/instantevents",
			{
				method:"get",
				parameters:{
					"im.window_closed":1
				}
			});
		
		this.addAChatIfMissing(partner_screenname);
		this.m_open_chats[partner_screenname.toLowerCase()].hide();
		this.adjustWindowWidths();
	},
	popChat : function(partner_screenname) {
		this.addAChatIfMissing(partner_screenname);
		var w_width = (typeof(ad_popout_chat_display) != 'undefined' && ad_popout_chat_display == 1) ? 440 : 375;
		var w_height = (typeof(ad_popout_chat_display) != 'undefined' && ad_popout_chat_display == 1) ? 470 : 450;
		var add_cgi_pass = "";
		
		// The commented three lines transfer branding to a popped chat 
		
		if(Branding.on) {
			check = $("im_container_" + this.m_open_chats[partner_screenname.toLowerCase()].m_window_id).down();
			brandname = Branding.check_for_brand(check);

			if(brandname) {
				add_cgi_pass = "&branded=" + brandname;
			}
		}
		var w = window.open("/instantevents/popup.html?partner_screenname="+partner_screenname + add_cgi_pass,partner_screenname.toLowerCase(),"height="+w_height+",width="+w_width+",scrollbars=1,location=0,resizable=1");	
		// Should exist now, unless popup failed
		
		if (w) {
			w.focus();			
			this.m_open_chats[partner_screenname.toLowerCase()].popChat();
			this.adjustWindowWidths();
		}
		else {
			alert("You have a popup blocker that is preventing pop-out IM windows.");
		}
	},
	// We have 2 things to worry about with popping out:
	//   1. That popping out from 1 window will still hide it from all the rest.
	//   2. That closing popout brings it back everywhere.
	//
	//  This obviously requires cookie communication.
    //
    // Every second or so this guy runs and looks for
	// a short-lived pop back in directive, or for lack of that,
	// a popout directove, both of which tell the uimanager to hide or show.
	watchForPopouts : function() {
		for (chat in this.m_open_chats) {
			var partner_tolower = this.m_open_chats[chat].m_partner_screenname.toLowerCase();
			var c = NanoCookie.get("unpop_" + partner_tolower);
			if (c) {
				if (c == "expand")
					ImUiManager.expandChat(partner_tolower);
				else if (c == "hide") 
					ImUiManager.hideChat(partner_tolower);
				else if (c == "collapse")
					ImUiManager.collapseChat(partner_tolower);
				else
					alert("popping back in to an unknown state.");
			}
			else {
				c = NanoCookie.get("im_state_" + partner_tolower);
				if (c && c == "popped") {
					this.m_open_chats[chat].popChat();
				}
			}
		}
	},	
	//
	// This is called every second by a popup window to prove it still exists.	
	maintainPopupState : function(partner_screenname) {
		NanoCookie.set('im_state_' + this.m_partner_screenname.toLowerCase(), "popped", {ms: 3000});
	},
	//
	// This is called by popup window to close and pop back in to regular documents
	// either automatically on close, or manually with a button click.  In latter case
	// we need to unattach close event so it doesn't double happen.
	unpopAndChangeState : function(partner_screenname, new_state) {
		NanoCookie.set("unpop_" + partner_screenname.toLowerCase(), new_state, {ms: 3000});
		Event.stopObserving(window,"beforeunload",this.m_close_action);
		window.close();
	},
	catchKeyStroke : function(e, partner_screenname,topic) {
		if (partner_screenname == false) {
			if (e.keyCode == 13) this.tryNewIm();
		}
		else if (e.keyCode == 13) {
			this.sendTo(partner_screenname,topic);
		}
		else if (this.m_open_chats[partner_screenname.toLowerCase()].m_has_attention) {
			this.loseAttention(partner_screenname);
		}
	},
	catchFocus : function(e,partner_screenname) {
		if (this.m_open_chats[partner_screenname.toLowerCase()].m_has_attention) {
			this.loseAttention(partner_screenname);
		}
	},
	catchContainerMouseover : function(e,partner_screenname) {
		if (this.m_open_chats[partner_screenname.toLowerCase()].m_has_attention) {
			this.loseAttention(partner_screenname);
		}
	},
	sendTo : function(partner_screenname,topic) {
		var im_window = this.m_open_chats[partner_screenname.toLowerCase()];
		if (im_window) {
			var msg = im_window.getTypedMessage();
		    msg = msg.replace("\n"," ");
		    msg = msg.replace("\r"," ");
		    msg = msg.replace("\t"," ");
			if (msg && msg.length > 0) {
				InstantEvents.sendAnIm(partner_screenname, msg, topic);
			}
			im_window.clearTypedMessage();
		}
		else { 
			alert("%{IE_NO_OPEN_IM_TO_THAT_PERSON}");
			return;
		}
	},
	adjustWindowWidths : function() {
		if (this.numVisibleChats() > 2)
			$(this.m_destination_div).removeClassName('large');
		else
			$(this.m_destination_div).addClassName('large');
	}
});

// Craig's first javascript class.  Yay!
var EventUiManagerImplementation = Class.create ({
	m_display_events : 0,
	m_destination_div : false,
	m_optional_params : {},
	m_event_div : "event_display",
	m_event_num : 0,
	m_event_count : 0,
	m_event_max : 2,
	//m_fade_effect : null,
	m_event_timer : null,
	invoke: function (destination_div, optional_params) {
		var c = NanoCookie.get('display_events');
		this.m_display_events = c == null ? 1 : c;
		this.m_destination_div = destination_div;
		if (optional_params)
			this.m_optional_params = optional_params;
	},
	createEventDisplay : function () {
		this.m_event_count = 0;
		var res =	'<div id="' + this.m_event_div + '_container">';
		res +=		'	<div id="' + this.m_event_div + '" onMouseOver="EventUiManager.mouseover();" onMouseOut="EventUiManager.mouseout();">'
			+		'		<div class="event_cap"></div>'
			+		'		<div class="event_tab">'
			+		'			<a href="#" class="close" title="%{IE_BUTTON_CLOSE}" onClick="EventUiManager.close (); return false;"></a>'
			+		'		</div>'
			+		'		<div id="' + this.m_event_div + '_body"></div>'
			+		'	</div>'
			+		'</div>';
		Element.insert(this.m_destination_div, {"top" : res});
	},
	update : function (person, event) {
		var image = '',
			image_title = '',
			comment = '<a href="/profile/' + person.screenname + '">' + person.screenname + '</a> ',
			his_her = person.gender == 'M' ? 'his' : 'her',
			skip_event = false;
		switch (event.type) {
			case "msg_notify":
				comment += 'sent you a message!';
				util.updateStats("instant events - orbit notice - sent you a message", 1, "counter", "b758qMsjuyd9attfg3TyPzFqnd4=");
				break;
			case "stalk":
				comment += 'just visited your profile';
				util.updateStats("instant events - orbit notice - you've been stalked", 1, "counter", "2sESFk0RMWcM2KvBrfARSA5c3q4=");
				break;
			case "journal_comment":
				comment += 'left a comment in your journal'; 
				util.updateStats("instant events - orbit notice - commented in your journal", 1, "counter", "MI7NdIer+XP0iweaqDIvRIWjrmM=");
				skip_event = true;
				break;
			case "looks_vote":
				comment = person.screenname + ' just rated you in <a href="/quickmatch">Quickmatch</a>!';
				util.updateStats("instant events - orbit notice - rated you", 1, "counter", "jeTns0XTD16gashWILzr5eFVQ60=");
				break;
			case "wiki_edit":
				comment += 'made a wiki edit to your profile';
				util.updateStats("instant events - orbit notice - made a wiki edit to your profile", 1, "counter", "Irby1kijEtGlbQ9WT+Bej2SHJXY=");
				break;
            case "orbit_going_public":
				comment += 'answered a question publicly!';
				util.updateStats("instant events - orbit notice - going public", 1, "counter", "CFKpdS8Sjo/ew05yJo4UADqmFxM=");
				break;
            case "orbit_q_note":
                comment += 'attached a note to a public question answer!';
                util.updateStats("instant events - orbit notice - question note", 1, "counter", "mmNK/G02VZEvRzW6tdu15Kn+6Iw=");
                break;
				
			/* NEW orbit types */
			case "broadcast":	// Update this case to use the necessary args when they become available
				comment = '<a href="/about/okcupid">OkCupid</a> just did something awesome!';
				util.updateStats("instant events - orbit notice - did something awesome", 1, "counter", "5mKfUeGHc+TS9JeHOJBHyvuQvi4=");
				break;
			case "orbit_journal_post":
				comment += 'just posted in ' + his_her + ' journal';
				util.updateStats("instant events - orbit notice - posted in their journal", 1, "counter", "RcwAUVoptvYPkTaPEKTXKSRla2s=");
				skip_event = true;
				break;
			case "orbit_board_comment":
				image = 'journal_comment', image_title = 'New journal comment';
				if (event.event_arg3 != undefined)
					comment += 'left a comment on <a href="/profile/' + event.event_arg2 + '">' + event.event_arg2 + '\'s</a> journal post titled <a href="' + event.event_arg1 + '">' + event.event_arg3 + '</a>';
				else
					comment += 'left a <a href="' + event.event_arg1 + '">comment</a> on <a href="/profile/' + event.event_arg2 + '">' + event.event_arg2 + '\'s</a> journal post';
				util.updateStats("instant events - orbit notice - journal comment", 1, "counter", "8bKTuhn9GkF2yiLtd7TbUgfcKvc=");
				skip_event = true;
				break;
			case "orbit_profile_updated":
				comment += 'edited ' + his_her + ' profile';
				util.updateStats("instant events - orbit notice - edited profile", 1, "counter", "zfturXyYvJJWpy2V0pAx6Xbu2ZE=");
				break;
			case "orbit_display_status_changed":
				comment += 'changed ' + his_her + ' status from ' + event.event_arg1 + ' to ' + event.event_arg2;
				util.updateStats("instant events - orbit notice - changed status", 1, "counter", "BVLeDQXWJIbbLayLTxjnON2auIg=");
				break;
			case "orbit_test_take":
				comment += 'took <a href="' + event.event_arg1 + '">' + event.event_arg2 + '</a> and scored <a href="' + event.event_arg3 + '">' + event.event_arg4 + '</a>';
				util.updateStats("instant events - orbit notice - took test", 1, "counter", "FXuWaNekr6dIl1mBN/dXaOkzB74=");
				break;
			case "orbit_nth_question":
				comment += 'has now answered ' + event.event_arg1 + ' questions';
				util.updateStats("instant events - orbit notice - nth question", 1, "counter", "tVgOVHxD4pZh60S6T74SbawRMKM=");
				break;
			case "orbit_forum_comment":
				comment += 'left a <a href="/forum?tid=' + event.event_arg1 + '#c-' + event.event_arg2 + '">comment</a> in the forum topic "' + event.event_arg3 + '"';
				util.updateStats("instant events - orbit notice - forum comment", 1, "counter", "zIt8EaUkh1u/MtEyjIVH1yaMU8s=");
				skip_event = true;
				break;
			case "orbit_forum_post":
				comment += 'made a post titled <a href="/forum?tid=' + event.event_arg1 + '">"' + event.event_arg2 + '"</a> in the forums';
				util.updateStats("instant events - orbit notice - forum post", 1, "counter", "/jd1jZfs7+FGWFyvuRgMr+yssJM=");
				skip_event = true;
				break;
			case "orbit_picture_upload":
				comment += 'uploaded a new photo'
				util.updateStats("instant events - orbit notice - photo upload", 1, "counter", "TR6fYD1jhJsrPrX5TYksZJPcGRs=");
				break;
			case "orbit_psychgame_take":
				comment += 'played <a href="/psychologist-game">The Psychologist Game</a> and scored ' + event.event_arg1 + ' points, with ' + event.event_arg2 + ' correct answers';
				util.updateStats("instant events - orbit notice - psych game", 1, "counter", "HMe6dW4DoxNLKq000zJ9DFewKYQ=");
				break;
			case "orbit_user_signon":
				comment += 'signed in';
				util.updateStats("instant events - orbit notice - logged in", 1, "counter", "HoZ17v6J7ctH2lMJ7Y/s+JGtw2w=");
				break;
			case "orbit_user_signoff":
				comment += 'signed out';
				util.updateStats("instant events - orbit notice - logged out", 1, "counter", "zdV8K0lCCsTpgBNcbUZ8+Spm97c=");
				break;
				
			/* Any new orbit type */
			case "orbit":
				util.updateStats("instant events - orbit notice - (unknown) orbit", 1, "counter", "f4U+kcs44Ym50p2mGFq40VP5kwg=");
				comment += 'just did something awesome';
			
			/* OkCupid toolbar update */
			case "toolbar_trigger":
				skip_event = true;
				break;
				
			default:
				comment = '<a href="/about/okcupid">OkCupid</a> just did something awesome';
				util.updateStats("instant events - orbit notice - (unknown) default", 1, "counter", "0aCL/AF3dLxbz/K5zoyiA8dovrw=");
		}
		if (!skip_event) {
			if (person.orientation == 'G') {
				person.orientation = "%{IE_ORIENTATION_GAY}";
			} else if (person.orientation == 'B') {
				person.orientation = "%{IE_ORIENTATION_BISEXUAL}";
			} else {
				person.orientation = "%{IE_ORIENTATION_STRAIGHT}";
			}
			if (person.thumb.length > 0) {
				var image_tag = '<img src="http://%{IMGRESIZE}/60x60/60x60/' + person.thumb + '" height="40" width="40" />';
			} else {
				var image_tag = '<img src="%{imagepath}media/img/user/d_60.png" height="40" width="40" />';
			}
			var new_event_style = (this.m_event_count >= this.m_event_max ? ' style="display: none;"' : '');
			var res = '';
			res +=	'<div id="event_wrapper_' + this.m_event_num + '"' + new_event_style + '><div>';
			res +=	'<div id="event_' + this.m_event_num + '" class="event clearfix">'							// event num taken off if wrapper works ?
				+	'	<p>' + comment + '</p>'
				+	'</div>';
			if (event.type != 'looks_vote') {
				res +=	'<div id="event_user_' + this.m_event_num + '" class="user event clearfix">'			// event num taken off if wrapper works ?
					+	'	<div class="top"></div>'
					+	'	<div class="body clearfix">'
					+	'		<a href="/profile/' + person.screenname + '" title="Visit ' + person.screenname + '\'s profile">'
					+	image_tag
					+	'		</a>'
					+	'		<p class="one">' + person.age + ' / ' + person.gender + ' / ' + person.orientation + '</p>'
					+	'		<p class="two">' + person.match + '% Match</p>'
					+	'		<p class="three">' + person.location + '</p>'
					+	'	</div>'
					+	'	<div class="bottom"></div>'
					+	'</div>';
			}
			res += '</div></div>'
			if (! $(this.m_event_div + '_container')) {
                this.createEventDisplay();
				$(this.m_event_div + '_body').update(res);
				this.m_event_count++;
			}
			else {
                
				clearTimeout (this.m_event_timer);
				if (this.m_event_count >= this.m_event_max) {
					$(this.m_event_div + '_body').innerHTML += res;
					$('event_wrapper_' + (this.m_event_num - this.m_event_count)).hide ();
					$('event_wrapper_' + this.m_event_num).show ();
				} else {
					$(this.m_event_div + '_body').innerHTML += res;
					this.m_event_count++;
				}
			}

			this.m_event_num++;
			this.m_event_timer = setTimeout ("$(EventUiManager.m_event_div + '_container').remove();", 12000);
        
        }
	},
	mouseover : function () {
		clearTimeout (this.m_event_timer);
	},
	mouseout : function () {
		this.m_event_timer = setTimeout ("$(EventUiManager.m_event_div + '_container').remove();", 12000);
	},
	close : function () {
		$(this.m_event_div + '_container').remove ();
	},
	toggleEvents : function () {
		this.m_display_events = 1 - this.m_display_events;
		NanoCookie.set('display_events', this.m_display_events,{ms:1000*3600*24*90});
		if (this.m_display_events) {
			$('display_events_off').hide ();
			$('display_events_on').show ();
		} else {
			$('display_events_on').hide ();
			$('display_events_off').show ();
		}
	}
});

var ImWindow = Class.create({
	m_state : 'expanded',
	m_partner_screenname : '',
	m_window_id : 0, // all html tags will include this id
	m_destination_div : false,
	m_has_attention : false,
	
	initialize : function(destination_div, partner_screenname, optional_params) {
		this.m_destination_div = destination_div;
		this.optional_params = optional_params || {};
		$(this.m_destination_div).style.display = ""; // in case it was entirely hidden.
		this.m_partner_screenname = partner_screenname;
		this.m_state = this.getAndRefreshStartState();
		this.m_window_id = Math.random() * 1000000000;
		this.draw();
	},
	getAndRefreshStartState : function() {
		var state = NanoCookie.get('im_state_' + this.m_partner_screenname.toLowerCase());
		if (state) {
			this.m_state = state;		
		}
		else {
			this.m_state = 'expanded';
		}
		this.writeStateToCookie();
		return this.m_state;
	},
	writeStateToCookie: function() {
		NanoCookie.set('im_state_' + this.m_partner_screenname.toLowerCase(), this.m_state, {ms:3599*1000});
	},
	addAnOpeningMessage : function(im_person) {
		if (typeof(im_person.sexpref) != 'undefined') {
			im_person.orientation = im_person.sexpref.toUpperCase().charAt(0);
		}
			
		var gender = (im_person.gender == 'M' ? "%{IE_GENDER_MALE}" : "%{IE_GENDER_FEMALE}");
		var orientation = "%{IE_ORIENTATION_STRAIGHT}";
		if (im_person.orientation == 'G')
			orientation = "%{IE_ORIENTATION_GAY}";
		else if (im_person.orientation == 'B')
			orientation = "%{IE_ORIENTATION_BISEXUAL}";
		if (! ImUiManager.m_is_a_popup) {
			var res = '<p class="new im_to_me clearfix">';
			if (im_person.thumb != '')
				res += '<img src="http://%{IMGRESIZE}/60x60/60x60/' + im_person.thumb + '" height="60" width="60" title="An image of ' + im_person.screenname + '" />';
			else
				res += '<img src="http://cdn.okccdn.com/media/img/user/d_60.png" height="60" width="60" title="An image of ' + im_person.screenname + '" />';
			res += ''
				+ '<span class="">' + im_person.age + '</span>'
				+ '<span class="slash">/</span>'
				+ '<span class="">' + gender + '</span>'
				+ '<span class="slash">/</span>'
				+ '<span class="">' + orientation + '</span>'
				+ '<span class="location">' + im_person.location + '</span>'
				+ '</p>';
			$('im_expanded_contents_' + this.m_window_id).innerHTML = res + $('im_expanded_contents_' + this.m_window_id).innerHTML;
		} else {
			var res = '<p class="user image"><a href="/profile/' + im_person.screenname + '" target="_blank">';
			if (im_person.thumb != '')
				res += '<img src="http://%{IMGRESIZE}/60x60/60x60/' + im_person.thumb + '" height="42" width="42" title="An image of ' + im_person.screenname + '" />';
			else
				res += '<img src="%{imagepath}media/img/user/d_60.png" alt="Default user image" width="41" height="41" border="0" title="Default user image" />';
			res += 	'</a></p>'
				+	'<p class="user name"><a href="/profile/' + im_person.screenname + '" target="_blank">' + this.m_partner_screenname + '</a></p>'
				+	'<p class="user aso">' + im_person.age + ' / ' + gender + ' / ' + orientation + '</p>'
				+	'<p class="user location">' + im_person.location + '</p>';
			$('info_area').innerHTML += res;
		}
	},
	addAMessage : function(msg, from_me, msg_gmt) {
		
		var windowObj = $("im_container_" + this.m_window_id) || $("p_popout_chat");
		
		var d = new Date (msg_gmt * 1000);
		var archive = (InstantEvents.m_last_server_gmt_sync - msg_gmt > InstantEvents.m_message_age_before_considered_archive ? ' archive' : '');
		var sn = from_me ? SCREENNAME : this.m_partner_screenname;
		
		/* 
		
			McD checks 
			
			These were the checks for the first im branding.
			left in because we're likely to  do it again.
		
		*/
		if(Branding.on) {
			brand_shell = windowObj.down();
			brandname = Branding.check_for_brand(brand_shell);
			if(brandname 
			&& Branding.campaigns[brandname].badwords
			&& util.isTextDirty(msg)) {
				$(brand_shell).removeClassName(brandname);
				$(brand_shell).removeClassName(Branding.campaigns[brandname].classname);
			}
		
			var post_ad_stats = false;
		
			if(InstantEvents.m_last_server_gmt_sync - msg_gmt < InstantEvents.m_seconds_to_consider_new
			&& $(brand_shell).hasClassName(brandname)) {
				post_ad_stats = brandname;
			}
        
			if(this.pending_impression && $(brand_shell).hasClassName(brandname)) {
				post_ad_stats = brandname;
			}
			this.pending_impression = false;
		}
		try {
			content = eval('(' + msg + ')');
			if(content.topic && $('topic_' + this.m_window_id)) this.loadTopic(content.topic);
			msg = content.text;
		} catch (e) {
			msg = msg;
		}

		
		var res = '';
		if (msg.startsWith('/me')) {
			res += '<p class="im_third_person' + archive + '"><span class="timestamp">[' + makeSmartDateString(d, IM_FORMAT) + ']</span>'
				+ sn + msg.substring(3).stripTags()
		} else {
			res += '<p class="' + (from_me ? 'im_from_me' : 'im_to_me') + archive + '"><span class="timestamp">[' + makeSmartDateString(d, IM_FORMAT) + ']</span>';
			if (ImUiManager.m_is_a_popup) 
				res += '<a href="/profile/' + sn + '" target="_blank" class="user">' + sn + ':</a>';
			else 
				res += '<a href="/profile/' + sn + '" class="user">' + sn + ':</a>';
			res += msg.stripTags();
		}
		
		if(post_ad_stats) { 
			var timestamp = new Date().getTime(); 
			if(Branding.campaigns[post_ad_stats].pixel) {
				url = util.jogf(Branding.campaigns[post_ad_stats].pixel,{timestamp:timestamp});
			    res += '<img src="' + url + '" border="0" width="1" height="1" />'; 
			}
			hash = Branding.campaigns[post_ad_stats].stathash;
			name = Branding.campaigns[post_ad_stats].statname;
			util.updateStats(name, 1, "counter", hash);
		}

		res += '</p>';
		$('im_expanded_contents_' + this.m_window_id).innerHTML += res;
	},	
	addASystemMessage : function(msg) {
		var res = ""
		   		+ '<p class="im_from_system">'
				+  msg.stripTags();
				+ '</p>';
		$('im_expanded_contents_' + this.m_window_id).innerHTML += res;
		this.maintainScrollTop();
	},
	addAStaffRobotMessage : function(msg) {
		var res;
		if (msg == 'nag') {
			switch (Math.floor(Math.random()*5)) {
				case 0:
					res = 'Staff Robot here. People respond better to thoughtful messages.  Try that!';
					break;
				case 1:
					res = 'Hey! You\'ve been sending a lot of messages.  Try lowering quantity and increasing quality to get more responses.';
					break;
				case 2:
					res = 'Science has proven: thoughtful messages are the most attractive.';
					break;
				case 3:
					res = 'Try sending fewer users more composed messages.  You might get better responses!';
					break;
				case 4:
					res = 'Try writing well thought out messages to increase peoples\' tendancy to respond to you.';
					break;
				default:
			}
		}
		msg = '<div class="im_from_staffrobot">' + (res || msg) + '</div>';
		$('im_expanded_contents_' + this.m_window_id).innerHTML += msg;
		this.maintainScrollTop();
	},
	doBlock: function(do_it) {
	    var pass_name = this.m_partner_screenname;
		var html = "";
		if (do_it) {
			html += '<p>'
			+ util.jogf("%{IE_BLOCK_DONE}",{p_screenname:pass_name})
			+ '</p>'
			+ ' <a href="#" class="im_action yes" onClick="ImUiManager.hideChat(\'' + pass_name + '\'); return false;">%{IE_BUTTON_CLOSE}</a>';
			InstantEvents.blockImAjax(this.m_partner_screenname);
		}
		else {
			html += "<p><strong>%{IE_DISASTER_AVERTED}</strong><br /><br />%{IE_DISASTER_AVERTED_MORE}</p>";
		}
		this.updateBlockPane(html);
		$('message_' + this.m_window_id).value = "blocked";
		$('message_' + this.m_window_id).setStyle({fontStyle:'italic', fontWeight:'bold', color:'#555'});
		$('message_' + this.m_window_id).disable();
	},
	maintainScrollTop : function() {
		if (! ImUiManager.m_is_a_popup)
			$('im_expanded_contents_' + this.m_window_id).scrollTop = 100000000;
		else
			window.scrollBy(0,100000000);
	},
	drawAttention : function() {
        //PW - HERE for check for focus
		if (!this.m_has_attention) {
			this.m_has_attention = true;
			if (this.m_state == "hidden") {
				this.collapse();
			}
			$('im_wrapper_' + this.m_window_id).addClassName("alert");
			setTimeout('ImUiManager.flashAttention(\'' + this.m_partner_screenname + '\');', 1000);
		}
	},
	flashAttention : function () {
		if (this.m_has_attention && ! ImUiManager.m_is_a_popup) {
			if ($('im_wrapper_' + this.m_window_id).hasClassName("alert")) {
				$('im_wrapper_' + this.m_window_id).removeClassName("alert");
			}
			else {
				$('im_wrapper_' + this.m_window_id).addClassName("alert");
			}
			setTimeout('ImUiManager.flashAttention(\'' + this.m_partner_screenname + '\');', 1000)
		}
	},
	loseAttention : function() {
		if (!ImUiManager.m_is_a_popup) {
			this.m_has_attention = false;
			$('im_wrapper_' + this.m_window_id).removeClassName("alert");
		}
	},
	
	loadTopic:function (topic) {
		$('topic_' + this.m_window_id).innerHTML = ''
			+ "<p class='topic_tab'>" 
		    + "		<span>"
			+ 		topic
			+ "		</span>"
		    + "</p>";
	},
	
	draw: function() {

		var res = "";
		var wrapper_style = '';
		if (this.m_state == 'expanded') {
			wrapper_style = ' expanded';
		}
		else if (this.m_state == 'collapsed') {
			wrapper_style = ' collapsed';
		}
		else if (this.m_state == 'hidden' || this.m_state == "popped") {
			wrapper_style = ' hidden';
		}
		
		if(this.optional_params.topic && this.optional_params.topic != "")
			topic_tab = ""
			    + "<p class='topic_tab'>" 
			    + "		<span>"
				+ 		this.optional_params.topic
				+ "		</span>"
			    + "</p>";
		else 
			topic_tab = "";
		
		// Checks to see whether to brand the window
		
		active_brand = "";
		brand_ref = "";
		brand_clickthru = "";
		
		if(Branding.on && HAS_ADFREE != "1") {
			for(var brand in Branding.campaigns) {
				if(active_brand)
					break;
				
				_brand = Branding.campaigns[brand];
				if(!_brand.on)
					continue;
					
				triggerit = false;

				if(_brand.global)
					triggerit = true;
				else if(typeof(METRO_AREA) != "undefined" && METRO_AREA != "0" && _brand.metrocode.indexOf(METRO_AREA) != -1)
					triggerit = true;
				else if(_brand.polygons) {
					for(iter=0;iter<_brand.polygons.length;iter++) {
						if(util.polygonBoundary(_brand.polygons[iter],[USER_LAT,USER_LON])) {
							triggerit = true;
							break;
						}
					}
				}
				if (triggerit) {
					active_brand = _brand.classname;
					brand_ref = brand;
					if (_brand.clickthru)
						brand_clickthru = _brand.clickthru;
				}			
			}
			
			
			if(this.m_state == "popped" && $("p_popout_chat")) {
				$("p_popout_chat").className = active_brand;
			}

			this.pending_impression = true;
		}

		branding_prepend = '<div class="brand_shell '+active_brand+' '+brand_ref+'"><div class="utility1"></div><div class="utility2"></div>';
		branding_append = '<div class="utility3"></div>';
		if (brand_clickthru) 
			branding_append += '<div class="utility4"><a target="_blank" href="' + brand_clickthru + '"></a></div></div>';
		else
			branding_append += '<div class="utility4"></div></div>';

		var name_pass = this.m_partner_screenname;
		var key_pass = {p_screenname:name_pass};
		if (! ImUiManager.m_is_a_popup) {
			res += ''
				+  '<div class="im_container' + wrapper_style + '" id="im_container_' + this.m_window_id + '">' + branding_prepend
				+  '	<div class="im_wrapper" id="im_wrapper_' + this.m_window_id + '">'
				+  '    	<div class="im_block" id="im_block_' + this.m_window_id + '" style="display: none;">'
				+  '        	<div class="im_block_cap"></div>'
				+  '        	<div class="im_block_body" id="im_block_pane_' + this.m_window_id + '">'
				+  '            	<p class="im_block_text">' + util.jogf("%{IE_IGNORE_INSTRUCTIONS}",key_pass) + '</p>'
	            +  '            	<a href="#" class="im_action no" onClick="$(\'im_block_' + this.m_window_id + '\').toggle(); return false;">%{COMMON_NO}</a>'
				+  '            	<a href="#" class="im_action yes" onClick="ImUiManager.doImBlock(\'' + this.m_partner_screenname + '\', true); return false;">%{COMMON_YES}</a>'
				+  '            	<p class="im_block_check">%{IE_IGNORE_CONFIRM}</p>'
				+  '        	</div>'
				+  '        	<div class="im_block_bot"><p><a href="#" title="%{IE_BUTTON_BLOCK_USER}" onClick="$(\'im_block_' + this.m_window_id + '\').toggle(); return false;"></a></p></div>'
				+  '    	</div>'
				+  '		<div id="topic_' + this.m_window_id + '">'
				+ 			topic_tab
				+  ' 		</div>'
				+  '    	<div class="im_cap"></div><div class="im_tab">'
				+  '        	<a href="#" class="im_option close" title="%{IE_BUTTON_CLOSE}" onClick="ImUiManager.hideChat(\'' + this.m_partner_screenname + '\'); return false;"></a>'
				+  '        	<a href="#" class="im_option collapse" title="%{IE_BUTTON_MINIMIZE}" onClick="ImUiManager.collapseChat(\'' + this.m_partner_screenname + '\'); return false;" id="im_collapse_' + this.m_window_id + '"></a>'
				+  '        	<a href="#" class="im_option expand" title="%{IE_BUTTON_EXPAND}" onClick="ImUiManager.expandChat(\'' + this.m_partner_screenname + '\'); return false;" id="im_expand_' + this.m_window_id + '"></a>'
				+  '        	<a href="#" class="im_option block" title="%{IE_BUTTON_BLOCK_USER}" onClick="$(\'im_block_' + this.m_window_id + '\').toggle(); return false;"></a>'
				+  '        	<a href="#" class="im_option pop" title="%{IE_BUTTON_POP}" onClick="ImUiManager.popChat(\'' + this.m_partner_screenname + '\'); return false;" id="im_pop_' + this.m_window_id + '"></a>'
				+  '			<a href="/profile/' + this.m_partner_screenname + '">' + this.m_partner_screenname + '</a>'
				+  '    	</div>'
				+  '    	<div class="im_body" id="im_body_' + this.m_window_id + '">'
				+  '        	<div class="im_text" id="im_expanded_contents_' + this.m_window_id + '"></div>'
				+  '    		<div class="im_input">'
				+  '        		<input type="text" name="message" value="" id="message_' + this.m_window_id + '"/>'
				+  '    		</div>'
				+  '    	</div>'
				+  '	</div>'
				+  branding_append + '</div>'
		} else {
			res += branding_prepend
				+  '<div id="info_area">'
				+  '	<a href="#" class="im_option close" title="%{IE_BUTTON_CLOSE}" onClick="ImUiManager.unpopAndChangeState(\'' + this.m_partner_screenname + '\', \'hide\'); return false;"></a>'
				+  '	<a href="#" class="im_option pop" title="%{IE_BUTTON_POP_IN}" onClick="ImUiManager.unpopAndChangeState(\'' + this.m_partner_screenname + '\', \'expand\'); return false;" id="im_pop_' + this.m_window_id + '"></a>'
				+  '	<a href="#" class="im_option block" title="%{IE_BUTTON_BLOCK_USER}" onClick="$(\'block_area\').toggle (); return false;"></a>'
				+  '	<a href="#" class="im_option timestamps" title="%{IE_BUTTON_TIMESTAMPS}" onClick="$(\'im_expanded_contents_' + this.m_window_id + '\').toggleClassName(\'no_timestamps\'); return false;"></a>'
				+  '</div>'
				+  '<div class="info_area_dropshadow"></div>'
				+  '<div id="block_area" style="display: none;"><div id="im_block_pane_' + this.m_window_id + '" class="inner clearfix">'	// second div necessary for scriptaculous dropdown
				+  '    <a href="#" class="im_action no" onClick="$(\'block_area\').toggle (); return false;">%{COMMON_NO}</a>'
				+  '    <a href="#" class="im_action yes" onClick="ImUiManager.doImBlock(\'' + this.m_partner_screenname + '\', true); return false;">%{COMMON_YES}</a>'
				+  '	<p class="im_block_about">' + util.jogf("%{IE_IGNORE_HEADING}",key_pass) + '</p>'
				+  '	<p class="im_block_text">' + util.jogf("%{IE_IGNORE_INSTRUCTIONS}",key_pass) + '</p>'
				+  '</div><div class="block_area_dropshadow"></div></div>'
				+  '<div class="im_text no_timestamps" id="im_expanded_contents_' + this.m_window_id + '"></div>'
				+  '<div class="send_area">'
				+  '	<div class="input_wrapper">'
				+  '		<textarea name="message" value="" id="message_' + this.m_window_id + '"></textarea>'
			//	+  '		<input type="text" name="message" value="" id="message_' + this.m_window_id + '"/>'
				+  '	</div>'
				+  '</div>'
				+  branding_append;
		}	
		Element.insert( this.m_destination_div, {"top" : res});
		if (this.m_state == "expanded") {
			$('message_' + this.m_window_id).focus();
			this.registerTakeoverImpression();
		}
		
		// PW - HERE for focus/blur testing
		
		$('message_' + this.m_window_id).observe("keyup", ImUiManager.catchKeyStroke.bindAsEventListener(ImUiManager, this.m_partner_screenname, this.optional_params.topic));
		$('message_' + this.m_window_id).observe("focus", ImUiManager.catchFocus.bindAsEventListener(ImUiManager, this.m_partner_screenname));
		if (! ImUiManager.m_is_a_popup) {
			$('im_container_' + this.m_window_id).observe("mouseover", ImUiManager.catchContainerMouseover.bindAsEventListener(ImUiManager, this.m_partner_screenname));
		}
	},
	updateBlockPane : function (html) {
		$('im_block_pane_' + this.m_window_id).innerHTML = html;
	},
	getTypedMessage : function() {
		return $F('message_'+this.m_window_id);
	},
	clearTypedMessage : function() {
		$('message_'+this.m_window_id).value = "";
	},
	setState : function(new_state) {
		if (new_state == "collapsed") 
			this.collapse();
		else if (new_state == "expanded") 
			this.expand();
	},
	hide : function() {
		this.m_state = 'hidden';
		this.writeStateToCookie();
		ImUiManager.loseAttention(this.m_partner_screenname);
		if (! ImUiManager.m_is_a_popup)
		    $('im_container_' + this.m_window_id).removeClassName('expanded').removeClassName('collapsed').addClassName('hidden');
		else
		    ImUiManager.unpopAndChangeState (this.m_partner_screenname, 'hide');
	},
	popChat : function() {
		this.m_state = 'popped';
//		this.writeStateToCookie();  This cookie we don't write on popup because the popup window itself keeps resetting it every sec or so.
		ImUiManager.loseAttention(this.m_partner_screenname);
		if ($('im_container_' + this.m_window_id))
			$('im_container_' + this.m_window_id).removeClassName('expanded').removeClassName('collapsed').addClassName('hidden');		
	},	
	collapse : function() {
		if (this.m_state != "hidden") {
			ImUiManager.loseAttention(this.m_partner_screenname);
		}
		this.m_state = 'collapsed';
		this.writeStateToCookie();
		if ($('im_container_' + this.m_window_id))
			$('im_container_' + this.m_window_id).removeClassName('expanded').removeClassName('hidden').addClassName('collapsed');
	},
	expand : function() {
		this.m_state = 'expanded';
		this.writeStateToCookie();
		ImUiManager.loseAttention(this.m_partner_screenname);
		if (!ImUiManager.m_is_a_popup) {
			$('im_container_' + this.m_window_id).removeClassName('collapsed').removeClassName('hidden').addClassName('expanded');
			$('im_wrapper_' + this.m_window_id).focus();
		}
		this.registerTakeoverImpression();
	},
	unDraw : function() {
		alert("todo: undraw");
	},
	registerTakeoverImpression : function() {
		if (!$('im_container_' + this.m_window_id)) return;
		if (!Branding || Branding.opened) return;
		var pixel = '', randid = new Date().getTime();

		if ($('im_container_' + this.m_window_id).firstDescendant().hasClassName('venus_smooth')) {
			pixel = '<IMG id="pixel_' + this.m_window_id + '" SRC="http://ad.doubleclick.net/ad/N5767.3376.MATCH.COM/B5923077.27;sz=1x1;pc=[TPAS_ID];ord=[timestamp]?" BORDER=0 WIDTH=1 HEIGHT=1 ALT="Advertisement" />';
			pixel += '<img src="http://amch.questionmarket.com/adsc/d938744/2/940538/adscout.php?ord=[timestamp]" height="1" width="1" border="0">';
		}

		if (pixel != '' && !$('pixel_' + this.m_window_id)) {
			pixel = pixel.replace('[timestamp]', new Date().getTime());
			$('im_container_' + this.m_window_id).insert({bottom: pixel});

			setTimeout(this.sendStats.bindAsEventListener(this), 500);
		}

	},
	sendStats : function() {
		if (!Branding.opened && $('pixel_' + this.m_window_id) && $('pixel_' + this.m_window_id).visible()) {
			if (!Branding.opened_once) {
				Branding.opened_once = true;
				util.updateStats('ads - venus smooth - im - opened once', 1, 'counter', 'DZpzVf+WE7toTSjaKKghe5sGtbY=');
			}
			util.updateStats('ads - venus smooth - im - opened', 1, 'counter', 'szf/YWr1L9/W4DLCS1jWI734YiU=');
		}
		Branding.opened = true;
		setTimeout( function() { Branding.opened = false; }, 1000);
	}
});

// [[[ --------------------------------------------------------------------------
//  Helper function; allows us to insert an iframe in a div anywhere
//  and then refer to it like so:
// 
//   var ifr = IFrameInsertedAt($('some_div'));
//   ifr.doc.createElement("script")
//   etc.
// ----------------------------------------------------------------------------]]]

function IFrameInsertedAt(parentElement)
{
   var iframe = document.createElement("iframe");
   if(parentElement == null)
      parentElement = document.body;
   parentElement.appendChild(iframe);
   iframe.doc = null;
   if(iframe.contentDocument)
      // Firefox, Opera
      iframe.doc = iframe.contentDocument;
   else if(iframe.contentWindow)
      // Internet Explorer
      iframe.doc = iframe.contentWindow.document;
   else if(iframe.document)
      // Others?
      iframe.doc = iframe.document;
   if(iframe.doc == null)
      throw "Document not found, append the parent element to the DOM before creating the IFrame";

   // Create the script inside the iframe's document which will call the
   iframe.doc.open();
   iframe.doc.close();
   return iframe;
}

//document.domain="okcupid.com";
InstantEvents = new InstantEventsImplementation();
ImUiManager = new ImUiManagerImplementation();
EventUiManager = new EventUiManagerImplementation();
Event.observe(window,"beforeunload",InstantEvents.endConnections.bindAsEventListener(InstantEvents));
