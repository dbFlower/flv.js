/*
 * @filename ts-player.js
 */

import Log from '../utils/logger.js';
import Browser from '../utils/browser.js';
import PlayerEvents from './player-events.js';
import BasePlayer from './base-player.js';
import Transmuxer from '../core/transmuxer.js';
import TransmuxingEvents from '../core/transmuxing-events.js';
import MSEController from '../core/mse-controller.js';
import MSEEvents from '../core/mse-events.js';
import {ErrorTypes, ErrorDetails} from './player-errors.js';
import {createDefaultConfig} from '../config.js';
import {InvalidArgumentException, IllegalStateException} from '../utils/exception.js';

class TSPlayer extends BasePlayer {
    constructor() {
        super();
        this.TAG = 'TSPlayer';
        this._type = 'TSPlayer';
    }

}