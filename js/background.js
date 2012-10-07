// background.js

(function(window) {
	
	Object.extend = function(dest, source) {
		dest = dest || {};
		source = source || {};
		for (var property in source)
			dest[property] = source[property];
		return dest;
	};

	var Util = function(id) {
		if (typeof id == 'string') {

			// This should probably be rewritten to be this untested code:
			// var el = Popup.document.getElementById(id);
			// if (el) { Object.extend(el.prototype, Util.element_methods); }
			// else { el = null; }
			// return el;

			return Object.extend(PopupWindow.document.getElementById(id), Util.element_methods);
		}
		else {
			return id;
		}
	};

	Object.extend(Util, {

	 	element_methods: {
			visible: function() {return this.style.display != 'none';},
			show:    function() {this.style.display = ''; return this;},
			hide:    function() {this.style.display = 'none'; return this;},
			toggle:  function() {this.visible() ? this.hide() : this.show();},
			update:  function(content) {this.innerHTML = content || ''; return this;}
		},

		ajax_defaults: {
			method: 'POST',
			headers: {
				'Content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
				'Accept': 'text/javascript, text/html, application/xml, text/xml, */*'
			}
		},

		makeQueryString: function(params, no_encode) {
			var parameters = [];
			for (var p in params) {
				// arrays only.  js objects will probably break this - don't try passing through ajax.
				if (params[p] && typeof params[p] == 'object' && typeof params[p].length != 'undefined') {
					for (var i = 0; i < params[p].length; i++) {
						if (no_encode) {
							parameters.push(p + '=' + params[p][i]);
						} else {
							parameters.push(encodeURIComponent(p) + '=' + encodeURIComponent(params[p][i]));
						}
					}
				} else {
					if (no_encode) {
						parameters.push(p + '=' + params[p]);
					} else {
						parameters.push(encodeURIComponent(p) + '=' + encodeURIComponent(params[p]));
					}
				}
			}
			return parameters.join('&');
		},

		makeParamObject: function(str) {
			var pos = str.indexOf('?'), pairs = [];
			if (pos != -1)
				pairs = str.substr(pos + 1).split('&');
			var params = {};
			for (var i = 0; i < pairs.length; i++) {
				var pair = pairs[i].split('=');
				params[pair[0]] = pair[1];
			}
			return params;
		},

		xhrStateChange: function(xhr, options) {
			if (xhr.readyState == 4 && xhr.status >= 200 && xhr.status < 300 && options.onSuccess)
				options.onSuccess(xhr);
			if (xhr.readyState == 4 && (xhr.status < 200 || xhr.status >= 300) && options.onFailure)
				options.onFailure(xhr);
			if (xhr.readyState == 4 && options.onComplete)
				options.onComplete(xhr);
		},

		request: function(url, opts) {
			var options  = opts || {};
			var headers  = Object.extend(options.headers, this.ajax_defaults.headers);
			var params   = options.parameters || {};
			var payload  = this.makeQueryString(params);
			var xhr      = new XMLHttpRequest();
			xhr.open((options.method || this.ajax_defaults.method).toUpperCase(), url, true);
			for (var h in headers)
				xhr.setRequestHeader(h, headers[h]);
			xhr.onreadystatechange = this.xhrStateChange.bind(this, xhr, options);
			xhr.send(payload);
		},

		xpath: function(path, node) {
			return document.evaluate(path, node).iterateNext();
		},

		pluralize: function(count, word, suffix, plural_form) {
			if (count == 1)
				return word;
			else if (plural_form)
				return plural_form;
			else
				return word + suffix;
		}
	});

	window.Util = Util;

})(window);

var Popupwindow,
	Popup;

var Defaults = {
	colors: {
		blue:        [112,169,234,255], // [41,99,164,255],
		textblue:    [80,131,219,255],
		pink:        [248,50,101,255],
		orange:      [255,135,0,255],
		black:       [0,0,0,255],
		white:       [255,255,255,255],
		gray:        [180,180,180,255]
	},
	icons: {
		notifications: {
			okcupid: '/media/images/logged_in.png'
		},
		sr: {
			gray: '/media/images/sr_gray_2.png',
			blue: '/media/images/sr_blue.png',
			yellow: '/media/images/sr_yellow.png',
			pink: '/media/images/sr_pink.png',
			gray_loggedout: '/media/images/sr_gray_loggedout.png'
		}
	},
	sounds: {
		attention_1: '/media/audio/here-it-is.mp3',
		attention_2: '/media/audio/ringing-bells.mp3'
	},
	messages: {
		sr: 'Happy Day!'
	}
};

var BG = {

	site_url: 'http://www.okcupid.com',
	logged_in: false,
	update_view_time: false,
	okc_window_open: false,  // not sure what the better default would be

	gns_info: {},

	// For desktop notifications
	notification_data: null,

	url_timer: null,
	gns_interval: null,
	gns_interval_time: 10000,        // Normally 60 seconds - 10 for testing.

	initialize: function() {
		this.setupDefaults();
		this.setupChrome();
		this.setupListeners();
		this.getLoggedInState();
	},

	setupDefaults: function() {
		if (!localStorage.getItem('quiver')) {
			localStorage.setItem('quiver', 'true');
		}
	},

	setupChrome: function() {
		chrome.browserAction.setBadgeBackgroundColor({color: Defaults.colors.blue});
	},

	setupListeners: function() {
		chrome.cookies.onChanged.addListener(this.cookieChanged.bind(this));
	},

	// Called from the popup's init function each time a popup appears
	setupGlobals: function() {
		PopupWindow = chrome.extension.getViews({type: 'popup'})[0] || null;
		Popup = PopupWindow ? PopupWindow.Popup : null;
	},

	cookieChanged: function(changeInfo) {
		if (changeInfo.cookie.name == 'session' && changeInfo.cookie.domain.match(/\.okcupid\.com$/)) {
			this.getLoggedInState();
		}
	},

	getLoggedInState: function(cb) {
		chrome.cookies.get({
			url: 'http://okcupid.com',
			name: 'session'
		}, this.getLoggedInState_cb.bind(this, cb));
	},

	getLoggedInState_cb: function(cb, cookie) {
		this.logged_in = cookie ? true : false;
		this.logged_in ? this.loggedIn() : this.loggedOut();
		if (cb) cb(this.logged_in);
	},

	getPathUrl: function(path) {
		return this.site_url + path;
	},

	loggedIn: function() {
		chrome.browserAction.setIcon({path: Defaults.icons.sr.gray});  // icons.sr.blue
		// This line could be put in an "if (!Cupid)" switch and it'd be fine.  The only
		// thing it gets us when we don't do that is having the number color switch from
		// yellow back to blue instantly, instead of waiting for the next poll
		// - This comment no longer applies since the updateGNS line was commented out
		//   in Cupid.setupLoggedIn()
		this.setupGNSInterval();
		//if (Cupid)
		//	Cupid.setupLoggedIn();
	},

	loggedOut: function() {
		chrome.browserAction.setIcon({path: Defaults.icons.sr.gray_loggedout});
		this.clearGNSInterval();
		this.updateBadge(true);
		this.gns_info = {};
		//if (Cupid)
		//	Cupid.setupLoggedOut();
	},

	doLogin: function(username, password) {
		// Interestingly, if this is GET, it 1) does a redirect to /home, 2) passes full html back
		// If you leave it as post, it returns what you want.
		Util.request(this.getPathUrl('/login'), {
			parameters: {
				ajax: 1,
				username: username,
				password: password
			},
			onSuccess: this.doLogin_cb.bind(this),
			onFailure: this.doLogin_failure.bind(this)
		});
	},

	doLogin_cb: function(transport) {
		console.log(transport.responseText);
		var response = JSON.parse(transport.responseText);
		if (response.status == 'success') {
			// Then the cookie should change... wait for it
			//this.getLoggedInState();
		}
		else {
			Popup.loginError(response);
		}
	},

	doLogin_failure: function(transport) {
		console.log(transport.responseText);
	},

	doLogout: function() {
		Util.request(this.getPathUrl('/logout'), {
			parameters: {
				ajax: 1
			},
			onSuccess: this.doLogout_cb.bind(this),
			onFailure: this.doLogout_failure.bind(this)
		});
	},

	doLogout_cb: function(transport) {
		console.log(transport.responseText);
		var response = JSON.parse(transport.responseText);
		if (response.status == 'success') {
			this.getLoggedInState();
		}
		else {
			Popup.logoutError();
		}
	},

	doLogout_failure: function(transport) {
		console.log('doLogout failure');
	},

	setupGNSInterval: function() {
		this.clearGNSInterval();
		this.getGNSInfo();
		this.gns_interval = setInterval(this.getGNSInfo.bind(this), this.gns_interval_time);
	},

	clearGNSInterval: function() {
		clearInterval(this.gns_interval);
	},

	// Untested
	getGNSInfo: function() {
		var params = {
			get_info: 1
		};

		// If the popup was opened, it'll set this flag.  When the flag is set, tell the server that we
		// just viewed the popup.  This'll update the last viewed timestamp for the popup on the live site
		if (this.update_view_time) {
			params.update_view_time = 1;
			this.update_view_time = false;
		}

		Util.request(this.getPathUrl('/gns/remote'), {
			parameters: params,
			onSuccess: this.getGNSInfo_cb.bind(this),
			onFailure: this.getGNSInfo_failure.bind(this)
		});
	},

	// Untested
	getGNSInfo_cb: function(transport) {
		var res = JSON.parse(transport.responseText);
		if (/*!res.status &&*/ res.gns_info) {
			var old_gns_info = this.gns_info;
			this.gns_info = res.gns_info;

			if (!this.getSetting('quiver')) {
				this.removeQuiver();
			}

			this.updateBadge(false, old_gns_info);
			if (Popup)
				Popup.updateGNS();
		}
	},

	// Untested
	getGNSInfo_failure: function(transport) {
		// update the icon to show connection error.  also update some text
		// in the popup somewhere
	},

	removeQuiver: function() {
		var notifications = [];
		for (i = 0; i < this.gns_info.notifications.length; i++) {
			var n = this.gns_info.notifications[i];
			if (n.type == 3)
				this.gns_info.total -= n.count;
			else 
				notifications.push(n);
		}
		this.gns_info.notifications = notifications;
	},

	// Update the badge count based on this.gns_info
	// Play sounds if new things + sounds enabled
	updateBadge: function(clear, old_gns_info) {
		
		//var text = clear ? '' : this.gns_info.total || '';
		var text = (!clear && this.gns_info.total) || '';

		switch(this.gns_info.attention) {
			case 2:  var color = Defaults.colors.pink; break;
			case 1:  var color = Defaults.colors.blue; break;
			default: var color = Defaults.colors.gray; break;
		}

		chrome.browserAction.setBadgeText({text: text.toString()});
		chrome.browserAction.setBadgeBackgroundColor({color: color});

		// If we have old data to compare to and the old attention is less than the new attention
		// Actually this needs to check attention on a per-row basis, not for the whole thing
		// Scratch that - just check total at the end instead of attention
		if (old_gns_info && old_gns_info.notifications && (old_gns_info.total || 0) < this.gns_info.total) {
			this.okcWindowOpen(this.updateBadgeNotifications.bind(this, old_gns_info));
		}
	},

	// Pulled out into a separate function because we need to first determine whether or not any OkC windows
	// are open.  This requires using a chrome api function that takes a callback.
	updateBadgeNotifications: function(old_gns_info) {
		// Play a sound if enabled - right now this plays a sound based on the attention level for
		// *all notifications.*  Ideally it would play a sound based on the highest attention level
		// of the new items

		var sounds = this.getSetting('sounds');
		var sounds_on_closed = this.getSetting('sounds_okc_closed');

		if (sounds && !(sounds_on_closed && this.okc_window_open))
			this.playSound(Defaults.sounds['attention_' + this.gns_info.attention]);

		var notifications = this.getSetting('notifications');
		var notifications_on_closed = this.getSetting('notifications_okc_closed');
		
		if (notifications && !(notifications_on_closed && this.okc_window_open))
			this.showGNSNotification(old_gns_info);
	},

	getSetting: function(s) {
		return localStorage.getItem(s) == 'true';
	},

	playSound: function(s) {
		var sound = new Audio(s);
		sound.play();
	},

	// The snippet here is wrong - if you have one new message and get another new one, I *think* it will show
	// "2 new messages"  ...Or maybe not?
	showGNSNotification: function(old_gns_info) {
		for (var i = 0; i < this.gns_info.notifications.length; i++) {
			var current_n = this.gns_info.notifications[i];
			var old_n;
			for (var j = 0; j < old_gns_info.notifications.length; j++) {
				if (old_gns_info.notifications[j].type == current_n.type) {
					old_n = old_gns_info.notifications[j];
				}
			}
			if (!old_n)
				current_n.count_new = current_n.count;
			else
				current_n.count_new = current_n.count - old_n.count;
		}
		var n = webkitNotifications.createHTMLNotification('/html/notify.html');
		n.show();
		setTimeout(function() {
			n.cancel();
		}, 10000);
	},

	// Used to return the <li> rows for a <ul> #gns area.  Called from both Cupid (popup) and Notify.
	// new_only will just show the changes between the most recent update and the full local gns (not sure if implemented yet).
	getGNSRows: function(new_only) {
		var gns_info = this.gns_info;
		var rows = [];

		var total = gns_info.total;
		if (new_only) {
			total = 0;
			for (var i = 0; i < gns_info.notifications.length; i++) {
				total += gns_info.notifications[i].count_new || 0;
			}
		}

		if (!new_only)
			rows.push('<li class="first">' + total + Util.pluralize(total, ' Notification', 's') + '</li>');
		if (gns_info.notifications && gns_info.notifications.length) {
			for (var i = 0; i < gns_info.notifications.length; i++) {
				var n = gns_info.notifications[i];
				if (!new_only || n.count_new) {
					rows.push([
						'<li>',
							'<a class="n" href="#" onclick="BG.openTab(\'' + this.getNotificationPath(n, new_only) + '\')">',
								(function() {
									var thumbs = [];
									for (var i = 0; i < n.images.length; i++) {
										if (!new_only || i < n.count_new) {
											thumbs.push('<img title="' + n.images[i].username + '" src="' + n.images[i].path + '"/>');
										}
									}
									return thumbs.join('');
								})(),
								'<span class="desc">' + this.getNotificationSnippet(n, new_only) + '</span>',
								(n.count ? '<span class="count">' + n.count + '</span>' : ''),
								'<span class="tag attention_' + n.attention + '"></span>',
							'</a>',
						'</li>'
					].join(''));
				}
			}
		}
		else {
			rows.push('<li class="empty">No new notifications</li>');
		}

		return rows;
	},

	getNotificationPath: function(n, new_only) {
		if (new_only) {
			var path = n.extra.multi.path;
			if (n.count_new == 1 && n.type != 4) {
				path = n.extra.single.path.replace('USERNAME', n.images[0].username);
			}
			return BG.getPathUrl(path);
		}
		else {
			return BG.getPathUrl(n.path);
		}
	},

	getNotificationSnippet: function(n, new_only) {
		if (new_only) {
			var snippet = n.count_new > 1 ? n.extra.multi.snippet : n.extra.single.snippet;
			return snippet.replace('COUNT', n.count_new).replace('USERNAME', n.images[0].username);
		}
		else {
			return n.snippet;
		}
	},

	openTab: function(url) {
		chrome.tabs.create({url: url});
	},

	// See if an OkCupid window is open
	okcWindowOpen: function(cb) {
		chrome.windows.getAll({populate: true}, this.okcWindowOpen_cb.bind(this, cb));
	},

	okcWindowOpen_cb: function(cb, windows) {
		var okc_window_open = false;
		for (var i = 0; i < windows.length; i++) {
			for (var j = 0; j < windows[i].tabs.length; j++) {
				var tab = windows[i].tabs[j];
				if (tab.url.match(/okcupid\.com/)) {
					okc_window_open = true;
				}
			}
		}
		this.okc_window_open = okc_window_open;

		if (cb) cb();
	},

	// Might need permissions to see notifications?  Are you starting chrome with certain flags to show
	// them right now, or can you do it because it's in the manifest file?  Or both?

	// I don't think this function is used.  Only showGNSNotification is.
	notify: function(title, text) {
		var notification = webkitNotifications.createNotification(Defaults.icons.notifications.okcupid, title, text);
		notification.show();
	},


	// ========================================================================
	// TESTING


	notify2: function() {
		var notification = webkitNotifications.createNotification(
			'logged_in.png',
			'Howdy!',
			'This is some test text...'
		);
		notification.show();
	},

	test2: function(path) {
		Util.request(this.getPathUrl(path), {
			parameters: {
				mobile_app: 1
			},
			onSuccess: this.test2_cb.bind(this),
			onFailure: this.test2_failure.bind(this)
		});
	},

	test2_cb: function(xhr) {
		var response = JSON.parse(xhr.responseText);
		var total_notifications = 0;
		for (var i = 0; i < response.notifications.length; i++) {
			total_notifications += response.notifications[i].count;
		}
		chrome.browserAction.setBadgeBackgroundColor({color: [248, 50, 101, 255]});
		chrome.browserAction.setBadgeText({text: (total_notifications || '').toString()});
	},

	test2_failure: function(xhr) {
		console.log('failure');
	}
	
};

BG.initialize();