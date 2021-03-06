/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */
/*
    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 2 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

/* eslint-disable jsdoc/require-jsdoc */

const Mainloop = imports.mainloop;
const Signals = imports.signals;

// const Me = imports.misc.extensionUtils.getCurrentExtension();
// const Panel = Me.imports.panel;
import { MPRISPlayer } from './player.js';
import Settings from './settings.js';
import { DBus } from './dbus.js';
import PlayerUI from './ui.js';

export default class PlayerManager {
  constructor(menu, desiredMenuPosition) {
    this._disabling = false;
    // the menu
    this.menu = menu;
    this._settings = Settings.gsettings;
    this.desiredMenuPosition = desiredMenuPosition;
    this.menu.connect('open-state-changed', (menu, open) => {
      let keepActiveOpen = this._settings.get_boolean(Settings.MEDIAPLAYER_KEEP_ACTIVE_OPEN_KEY);
      if (open && keepActiveOpen) {
        this.showActivePlayer();
      }
    });
    this._settingChangeId = this._settings.connect('changed::' + Settings.MEDIAPLAYER_KEEP_ACTIVE_OPEN_KEY, (settings, key) => {
      if (settings.get_boolean(key)) {
        this.showActivePlayer();
      } else {
        this.closeAllPlayers();
      }
    });
    // players list
    this._players = {};
    this._addPlayerTimeOutIds = {};
    // player shown in the panel
    this._activePlayer = null;
    this._activePlayerId = null;
    // the DBus interface
    this._dbus = new DBus();
    // player DBus name pattern
    let nameRegex = /^org\.mpris\.MediaPlayer2\./;
    // load players
    this._dbus.ListNamesRemote(names => {
      let playerNames = [];
      for (let name of names[0]) {
        if (nameRegex.test(name)) playerNames.push(name);
      }
      playerNames.sort();
      for (let player of playerNames) {
        this._dbus.GetNameOwnerRemote(player, owner => {
          if (!this._disabling) this._addPlayer(player, owner);
        });
      }
    });
    // watch players
    this._ownerChangedId = this._dbus.connectSignal('NameOwnerChanged',
      (_proxy, _sender, [name, oldOwner, newOwner]) => {
        if (nameRegex.test(name) && !this._disabling) {
          if (newOwner && !oldOwner) this._addPlayer(name, newOwner);
          else if (oldOwner && !newOwner) this._removePlayerFromMenu(name, oldOwner);
          else this._changePlayerOwner(name, oldOwner, newOwner);
        }
      }
    );
  }

  get activePlayer() {
    return this._activePlayer;
  }

  set activePlayer(player) {
    if (player === this._activePlayer) return;

    if (player === null) {
      this._activePlayerId = null;
      this._activePlayer = null;
      this.emit('player-active-remove');
      return;
    }

    if (this._activePlayerId) {
      this._activePlayer.disconnect(this._activePlayerId);
      this._activePlayerId = null;
    }
    this._activePlayer = player;
    this._activePlayerId = this._activePlayer.connect('player-update',
      this._onActivePlayerUpdate.bind(this));
    let keepActiveOpen = this._settings.get_boolean(Settings.MEDIAPLAYER_KEEP_ACTIVE_OPEN_KEY);
    if (keepActiveOpen) this.showActivePlayer();
    this.emit('player-active-update', player.state);
  }

  showActivePlayer() {
    if (!this._activePlayer || !this.menu.actor.visible) return;
    for (let owner in this._players) {
      if (this._players[owner].player === this._activePlayer && this._players[owner].ui.menu) {
        this._players[owner].ui.menu.open();
        break;
      }
    }
  }

  closeAllPlayers() {
    for (let owner in this._players) {
      if (this._players[owner].ui.menu) this._players[owner].ui.menu.close();
    }
  }

  nbPlayers() {
    return Object.keys(this._players).length;
  }

  getPlayersByStatus(status, preference) {
    // Return a list of running players by status and preference
    // preference is a player instance, if found in the list
    // it will be put in the first position
    return Object.keys(this._players)
      .map(owner => this._players[owner].player)
      .filter(player => player && player.state.status === status)
      .sort((a, b) => {
        if (a === preference) return -1;
        else if (b === preference) return 1;
        else return 0;
      });
  }

  _isInstance(busName) {
    // MPRIS instances are in the form
    //   org.mpris.MediaPlayer2.name.instanceXXXX
    // ...except for VLC, which to this day uses
    //   org.mpris.MediaPlayer2.name-XXXX
    return busName.split('.').length > 4 ||
                /^org\.mpris\.MediaPlayer2\.vlc-\d+$/.test(busName);
  }

  _addPlayer(busName, owner) {
    // Give players 1 sec to populate their interfaces before actually adding them.
    if (this._addPlayerTimeOutIds[busName] && this._addPlayerTimeOutIds[busName] !== 0) {
      Mainloop.source_remove(this._addPlayerTimeOutIds[busName]);
      this._addPlayerTimeOutIds[busName] = 0;
    }
    this._addPlayerTimeOutIds[busName] = Mainloop.timeout_add_seconds(1, () => {
      this._addPlayerTimeOutIds[busName] = 0;
      if (this._players[owner]) {
        let prevName = this._players[owner].player.busName;
        // HAVE:       ADDING:     ACTION:
        // master      master      reject, cannot happen
        // master      instance    upgrade to instance
        // instance    master      reject, duplicate
        // instance    instance    reject, cannot happen
        if (this._isInstance(busName) && !this._isInstance(prevName)) {
          this._players[owner].player.busName = busName;
        } else {
          return false;
        }
      } else if (owner) {
        let player = new MPRISPlayer(busName, owner);
        let ui = new PlayerUI(player);
        this._players[owner] = {
          player: player,
          ui: ui,
          signals: [],
          signalsUI: []
        };
        if (this.nbPlayers() === 1) this.emit('connect-signals');
        let playerItem = this._players[owner];
        let playerUpdateId = playerItem.player.connect(
          'player-update',
          this._onPlayerUpdate.bind(this)
        );
        playerItem.signals.push(playerUpdateId);
        this._addPlayerToMenu(owner);
      }
      return false;
    });
  }

  _onPlayerUpdate(player, newState) {
    if (newState.status) {
      this._refreshActivePlayer(player);
    }
  }

  _onActivePlayerUpdate(player, newState) {
    this.emit('player-active-update', newState);
  }

  _addPlayerToMenu(owner) {
    let actualPos = this.desiredMenuPosition + this.nbPlayers();
    let playerItem = this._players[owner];
    this.menu.addMenuItem(playerItem.ui, actualPos);
    this._refreshActivePlayer(playerItem.player);
  }

  _getMenuItem(position) {
    let items = this.menu.box.get_children().map(actor => actor._delegate);
    if (items[position]) return items[position];
    else return null;
  }

  _removeMenuItem(position) {
    let item = this._getMenuItem(position);
    if (item) item.destroy();
  }

  _getPlayerMenuPosition(ui) {
    let items = this.menu.box.get_children().map(actor => actor._delegate);
    for (let i in items) {
      if (items[i] === ui) return i;
    }
    return null;
  }

  _removePlayerFromMenu(busName, owner) {
    if (this._players[owner]) {
      // please excuse my variable names
      for (let signal of this._players[owner].signals) {
        this._players[owner].player.disconnect(signal);
      }
      for (let signal of this._players[owner].signalsUI) {
        this._players[owner].ui.disconnect(signal);
      }
      if (this._players[owner].ui) this._players[owner].ui.destroy();
      if (this._players[owner].player) this._players[owner].player.destroy();
      delete this._players[owner];
    }
    this._refreshActivePlayer(null);
    if (this.nbPlayers() === 0) this.emit('disconnect-signals');
  }

  _changePlayerOwner(busName, oldOwner, newOwner) {
    if (this._players[oldOwner] && busName === this._players[oldOwner].player.busName) {
      this._players[newOwner] = this._players[oldOwner];
      this._players[newOwner].player.owner = newOwner;
      delete this._players[oldOwner];
    }
    this._refreshActivePlayer(this._players[newOwner].player);
  }

  _refreshActivePlayer(player) {
    // Display current status in the top panel
    if (this.nbPlayers() > 0) {
      // Get the first player
      // with status PLAY or PAUSE
      // else all players are stopped
      this.activePlayer = []
        .concat(
          this.getPlayersByStatus(Settings.Status.PLAY, player),
          this.getPlayersByStatus(Settings.Status.PAUSE, player),
          this.getPlayersByStatus(Settings.Status.STOP, player)
        )[0] || null;
    } else {
      this.activePlayer = null;
    }
  }

  destroy() {
    this._disabling = true;
    this._settings.disconnect(this._settingChangeId);
    if (this._ownerChangedId) {
      this._dbus.disconnectSignal(this._ownerChangedId);
    }
    for (let owner of Object.keys(this._players)) {
      this._removePlayerFromMenu(null, owner);
    }
    // Cancel all pending timeouts. Wouldn't want to try to add a player if we're disabled.
    for (let busName in this._addPlayerTimeOutIds) {
      if (this._addPlayerTimeOutIds[busName] !== 0) {
        Mainloop.source_remove(this._addPlayerTimeOutIds[busName]);
        this._addPlayerTimeOutIds[busName] = 0;
      }
    }
  }
}
Signals.addSignalMethods(PlayerManager.prototype);
