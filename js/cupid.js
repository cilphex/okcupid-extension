// popup.js

var Background;
var Util, $;
var BG;
var InstantEvents;


// colors:
// blue:   #2963a4 - 41,99,164
// orange: #FF8700 - 255,135,0
// pink:   #f83265 - 248,50,101


var Cupid = {

	message: '',

	initialize: function(login) {
		// For testing purposes only:
		try {
			this.setupGlobals();
			BG.update_view_time = true;
			BG.setupGlobals();
			BG.getLoggedInState();

			this.message = BG.gns_info.message;

			if (this.message) {
				var m = this.message.match(/href="(.+)"/);
				if (m && m[1])
					this.message = this.message.replace(m[1], '#" onclick="BG.openTab(\'' + BG.getPathUrl(m[1]) + '\')');
			}
		}
		catch(e) {
			alert('Error in Cupid.initialize: ' + e);
		}
	},

	setupGlobals: function() {
		Background    = chrome.extension.getBackgroundPage();
		Util = $      = Background.Util;
		Defaults      = Background.Defaults;
		BG            = Background.BG;
		InstantEvents = Background.InstantEvents;
	},

	// Called from BG.loggedIn, after doing BG.getLoggedInState()
	setupLoggedIn: function() {
		$('logged_out').hide();
		$('logged_in').show();
		this.updateGNS();     // I *Think* this can be left out.
		                      // It can but that makes an extra flicker
	},

	// Called from BG.loggedOut, after doing BG.getLoggedInState()
	setupLoggedOut: function() {
		$('logged_in').hide();
		$('logged_out').show();
		document.getElementById('username').focus();
	},

	submitLogin: function(e) {
		if (e.keyCode != 13)
			return;
		var username = $('username').value;
		var password = $('password').value;
		BG.doLogin(username, password);
	},

	loginError: function(response) {
		alert('login error.  reason: ' + response.status);
	},

	logoutError: function() {
		alert('There was an error logging out');
	},

	// This should use some kind of templating system
	updateGNS: function() {
		if (!BG.gns_info.notifications)
			return;
		
		//var total = (Worker && Worker.gns_info && Worker.gns_info.total) || 0;
		//$('status').update(Util.pluralize(total, ' Notification', 's'));

		var rows = BG.getGNSRows();
		rows.push('<li class="last">' + (this.message || Defaults.messages.sr) + '</li>');
		$('gns').update(rows.join(''));
	},


	// ========================================================================
	// TESTING

	notify: function() {
		var notification = webkitNotifications.createNotification(
			'/media/images/logged_in.png',
			'Howdy!',
			'This is some test text...'
		);
		notification.show();
	},

	notify2: function() {
		this.notification = webkitNotifications.createHTMLNotification('notify.html');
		this.notification.show();
	},

	notify2Cancel: function() {
		this.notification.cancel();
	}

};