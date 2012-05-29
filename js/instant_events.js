// instant_events.js

// Singleton
var InstantEvents = {

	site_url:                  'http://www.okcupid.com',
	service_name:              '/instantevents',
	prefix_min:                1,
	prefix_max:                12,
	retry_timeout:             5,
	server_timeout:            70,
	new_timeout:               5,
	safety_throttle:           5,
	server_wait_min:           10,
	server_wait_max:           30,
	message_age_max:           3600,
	emergency_reopen_time:     40000,
	emergency_reopen_timeout:  null,



	
	// Call this from BG.initialize?
	// For now, just call it at the bottom
	initialize: function() {
		
	},

	// Turn instant events on
	enable: function() {
		
	},

	// Turn instantevents off
	disable: function() {
		
	}/*,

	perform*/



};

// Class
var IMWindow = function(username) {
	return ({

		username: username,
		
		initialize: function() {
			
			//InstantEvents.checkOnline({
			//	username: this.username,
			//	cb: 
			//});

			return this;
		}




	}).initialize();
}


InstantEvents.initialize();



/*
// If IM is on, or if this window is a popup, activate InstantEvents
if (this.m_active || this.m_is_a_popup) {
	this.performOnlineCheckNow();
	this.openConnection(true, false);
	if (this.m_is_a_popup)
		this.openAnImWindow(this.m_partner_screenname, optional_params);
}
*/