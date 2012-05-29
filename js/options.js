// options.js

// Probably don't need all of these.  Just in case.
var Background;
var Util, $;
var BG;
var InstantEvents;

var Options = {

	settings: [
		{                                      // Defaults don't do anything yet
			name: 'sounds',
			text: 'Sound notifications',
			'default': false,
			subsettings: [
				{
					name: 'sounds_okc_closed',
					text: 'Only when no OkCupid tabs are open',
					'default': false
				}
			]
		},
		{
			name: 'notifications',             // the local storage var that's saved
			text: 'Desktop notifications',
			'default': false,
			subsettings: [
				{
					name: 'notifications_okc_closed',
					text: 'Only when no OkCupid tabs are open',
					'default': false
				}
			]
		},
		{
			name: 'quiver',
			text: 'Include Quiver',
			'default': true
		}
	],

	initialize: function() {
		this.setupGlobals();
		this.injectSettings();
	},
	
	setupGlobals: function() {
		Background    = chrome.extension.getBackgroundPage();
		Util = $      = Background.Util;
		Defaults      = Background.Defaults;
		BG            = Background.BG;
		InstantEvents = Background.InstantEvents;
	},
	
	injectSettings: function() {
		var options = document.getElementById('options');
		for (var i = 0; i < this.settings.length; i++) {
			var setting = this.settings[i];
			var li = this.getSettingRow(setting);
			options.appendChild(li);

			if (setting.subsettings) {
				for (var j = 0; j < setting.subsettings.length; j++) {
					var subsetting = setting.subsettings[j];
					subsetting.class_name = 'subsetting ' + setting.name;
					if (!setting.enabled) {
						subsetting.style = 'display: none;';
					}
					var li = this.getSettingRow(subsetting);
					options.appendChild(li);
				}
			}
		}
	},
	
	getSettingRow: function(setting) {
		var li = document.createElement('li');
			li.setAttribute('class', setting.class_name || '');
			li.setAttribute('style', setting.style || '');
		var label = document.createElement('label');
		var path = document.createElement('span');
		    path.setAttribute('class', 'path');
		var checkbox = document.createElement('input');
		    checkbox.setAttribute('type', 'checkbox');
		
		setting.enabled = localStorage.getItem(setting.name) == 'true';
		if (setting.enabled)
		    checkbox.checked = true;

		var label_text = document.createTextNode(' ' + setting.text);
		label.appendChild(path);
		label.appendChild(checkbox);
		label.appendChild(label_text);
		var span = document.createElement('span');
		    span.setAttribute('id', 'save_' + setting.name);
		    span.setAttribute('class', 'saved hide');
		    span.innerHTML = 'Saved';
		li.appendChild(label);
		li.appendChild(span);

		checkbox.addEventListener('change', this.settingChanged.bind(this, setting));

		setting.li = li;
		setting.checkbox = checkbox;

		return li;
	},

	settingChanged: function(setting, event, is_checked) {
		var checked = event ? event.target.checked : is_checked;
		localStorage.setItem(setting.name, checked);

		if (setting.subsettings) {
			for (var i = 0; i < setting.subsettings.length; i++) {
				var sub = setting.subsettings[i];
				if (!checked) {
					sub.li.style.display = 'none';
					sub.checkbox.checked = false;
					this.settingChanged(sub, null, false);
				}
				else {
					sub.li.style.display = '';
				}
			}
		}

		var saved_label = document.getElementById('save_' + setting.name);
		saved_label.setAttribute('class', 'saved show');
		setTimeout(function() {
			saved_label.setAttribute('class', 'saved hide');
		}, 2500);
	}
};