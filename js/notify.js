// notify.js

var Background,
	Util,
	BG;

// There might be different types of notifications, and if so, this file should be renamed to
// gns_notification.html or something like that.  something more specific, less generic

var Notify = {

	initialize: function() {
		this.setupGlobals();
		this.setupContent();
	},

	setupGlobals: function() {
		Background  = chrome.extension.getBackgroundPage();
		Util        = Background.Util;
		Defaults    = Background.Defaults;
		BG          = Background.BG;
	},

	setupContent: function() {
		var rows = BG.getGNSRows(true);
		$('#gns').html(rows.join(''));
	}
};

document.addEventListener('DOMContentLoaded', Notify.initialize.bind(Notify));