/*
 * Copyright 2022 Ilker Temir <ilker@ilkertemir.com>
 * 
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const filePath = require('path')
const sqlite3 = require('sqlite3')
const request = require('request')

module.exports = function(app) {
  var plugin = {};
  var unsubscribes = [];
  var db;
  var suppressedNotificationTypes=[];
  var apiKey;
  var userKey;

  plugin.id = "notifications";
  plugin.name = "Notifications Manager";
  plugin.description = "Notifications management for SignalK";;

  plugin.start = function(options) {
    app.setPluginStatus('No notifications yet');
    apiKey = options.apiKey;
    userKey = options.userKey;

    let dbFile= filePath.join(app.getDataDirPath(), 'notifications.sqlite3');
    db = new sqlite3.Database(dbFile);
    db.run('CREATE TABLE IF NOT EXISTS notifications(ts INTEGER,' +
           '                                 count INTEGER,' +
           '                                 latitude REAL,' +
           '                                 longitude REAL,' +
           '                                 type TEXT,' +
           '                                 priority TEXT,' +
           '                                 message TEXT)');
    db.run('CREATE TABLE IF NOT EXISTS suppressed_notification_types(created_on INTEGER,' +
           '                                 type TEXT)');
    db.all('SELECT * from suppressed_notification_types', function(err, data) {
      for (let i in data) {
        suppressedNotificationTypes.push(data[i].type);
      }
      app.debug(data);
      app.debug(`Suppressed notifications: ${suppressedNotificationTypes}`);
    });
    let subscription = {
      context: 'vessels.self',
      subscribe: [{
        path: 'notifications.*',
        period: 5000
      }]
    };

    app.subscriptionmanager.subscribe(subscription, unsubscribes, function() {
      app.error('Subscription error');
    }, data => processDelta(data));
  }

  plugin.stop =  function() {
    if (db) {
      db.close();
    }
  };

  plugin.schema = {
    type: 'object',
    required: [],
    properties: {
      apiKey: {
        type: 'string',
        title: 'API Token/Key (obtain from pushover.net)'
      },
      userKey: {
        type: 'string',
        title: 'User Key (obtain from pushover.net)'
      }
    }
  }

  function sendPushNotification(message, type) {
    if (!(apiKey && userKey)) {
      app.debug('API Key and User Key not configured, not sending push notification');
      return;
    }
    app.debug('Sending push notification');
    request.post({
      url: "https://api.pushover.net/1/messages.json",
      form: {
        token: apiKey,
        user: userKey,
        message: `${message} (${type})`
      }
    }, function(error, response, body) {
      if (!error && response.statusCode == 200) {
        app.debug('Push notification sent');
      } else {
        app.debug('Push notification failed');
      }
    });
  }

  function updateDatabase(ts, latitude, longitude, type, priority, message) {
    let now = new Date();
    let limit = now - 15*60*1000;
    let query=`SELECT rowid, * FROM notifications WHERE type='${type}' AND priority='${priority}' AND ts >= ${limit} ORDER BY ts DESC LIMIT 1`;
    db.all(query, function(err, data) {
      if (data.length == 0) {
        let values = [ts, 0, latitude, longitude, type, priority, message];
        app.debug(`Inserting ${values} to DB.`);
	db.run('INSERT INTO notifications VALUES(?, ?, ?, ?, ?, ?, ?)', values, function(err) {});
	let date = new Date();
        app.setPluginStatus(`${message} at ${date}`);
	if (priority != "normal") {
	  sendPushNotification(message, type);
	}
      } else {
	let rowId = data[0].rowid;
	let count = data[0].count;
	app.debug(`Updating DB row ${rowId} for notification type ${type}, previous count was ${count}.`);
	count++;
	db.run(`UPDATE notifications SET count=${count} WHERE rowid=${rowId}`);
	let date = new Date();
        app.setPluginStatus(`${message} (${count} times) at ${date}`);
      }
    });
  }

  function processDelta(data) {
    let dict = data.updates[0].values[0];
    let path = dict.path.replace('notifications.','');
    if (suppressedNotificationTypes.includes(path)) {
      app.debug(`Notification type ${path} suppressed, ignoring`);
      return;
    }
    let value = dict.value;
    let ts = Date.now();
    let position = getKeyValue('navigation.position', 60);
    updateDatabase(ts, position.latitude, position.longitude, path, value.state, value.message);
  }

  function getKeyValue(key, maxAge) {
    let data = app.getSelfPath(key);
    if (!data) {
      return null;
    }
    let now = new Date();
    let ts = new Date(data.timestamp);
    let age = (now - ts) / 1000;
    if (age <= maxAge) {
      return data.value
    } else {
      return null;
    }
  }

  plugin.registerWithRouter = function(router) {
    router.get("/getNotifications", (req, res) => {
      if ('since' in req.query) {
        let since = parseInt(req.query.since);
        let query=`SELECT rowid, * FROM notifications WHERE priority!="normal" AND ts > ${since} ORDER BY ts DESC`;
        db.all(query, function(err, data) {
          res.send(data);
        });
      } else {
        let query=`SELECT rowid, * FROM notifications WHERE priority!="normal" ORDER BY ts DESC`;
        db.all(query, function(err, data) {
          res.send(data);
        });
      }
    });
    router.get("/getSuppressedNotifications", (req, res) => {
      let query=`SELECT rowid, * FROM suppressed_notification_types ORDER BY created_on DESC`;
      db.all(query, function(err, data) {
        res.send(data);
      });
    });
    router.post("/deleteNotification", (req, res) => {
      let rowId = req.body.rowid;
      app.debug(`Deleting record with rowId ${rowId}`);
      let query = `DELETE FROM notifications WHERE rowid=${rowId}`;
      db.all(query, function(err, data) {
        res.send(`Deleted rowID ${rowId}`);
      });
    });
    router.post("/suppressNotificationType", (req, res) => {
      let type = req.body.type;
      app.debug(`Suppressing notifications ${type}`);
      db.run(`DELETE FROM notifications WHERE type="${type}"`);
      let date = new Date();
      let query = `INSERT INTO suppressed_notification_types VALUES (?, ?)`;
      let values = [date.getTime(), type];
      suppressedNotificationTypes.push(type);
      db.all(query, values, function() {
        res.send('OK');
      });
    });
    router.post("/unSuppressNotificationType", (req, res) => {
      let type = req.body.type;
      app.debug(`Unsuppressing notifications ${type}`);
      db.run(`DELETE FROM suppressed_notification_types WHERE type="${type}"`, function() {
	let index = suppressedNotificationTypes.indexOf(type);
        if (index > -1) {
          suppressedNotificationTypes.splice(index, 1);
        }
        res.send('OK');
      });
    });
   }

  return plugin;
}
