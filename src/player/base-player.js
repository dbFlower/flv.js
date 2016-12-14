/*
 * @filename base-player.js
 */
import EventEmitter from 'events';
import FullscreenApi from '../utils/fullscreen-api';

class BasePlayer {
    constructor() {
        this._mediaElement = null;
        this._type = null;
        this._isFullscreen = false;
        this._emitter = new EventEmitter();
    }
    play() {
        this._mediaElement.play();
    }

    pause() {
        this._mediaElement.pause();
    }
    
    get played() {
        return this._mediaElement.played;
    }

    get paused() {
        return this._mediaElement.paused;
    }

    get isFullscreen() {
        return this._isFullscreen;
    }

    requestFullscreen() {
        const fsAPI = FullscreenApi;

        function fullscreenChange(ev) {
            this._isFullscreen = document[fsAPI.fullscreenElement];

            // If cancelling fullscreen, remove event listener.
            if (this.isFullscreen === false) {
                document.removeEventListener(fsAPI.fullscreenchange, fullscreenChange);
            }
        }

        document.addEventListener(fsAPI.fullscreenchange, fullscreenChange.bind(this));

        this._mediaElement[fsAPI.requestFullscreen]();

        return this;
    }

    requestFullScreen() {
        return this.requestFullscreen();
    }

    exitFullscreen() {
        const fsAPI = FullscreenApi;
        this._isFullscreen = false;

        document[fsAPI.exitFullscreen]();

        return this;
    }

    exitFullScreen() {
        return this.exitFullscreen();
    }

    get type() {
        return this._type;
    }

    get buffered() {
        return this._mediaElement.buffered;
    }

    get duration() {
        return this._mediaElement.duration;
    }

    get volume() {
        return this._mediaElement.volume;
    }

    set volume(value) {
        this._mediaElement.volume = value;
    }

    get muted() {
        return this._mediaElement.muted;
    }

    set muted(muted) {
        this._mediaElement.muted = muted;
    }

    get currentTime() {
        if (this._mediaElement) {
            return this._mediaElement.currentTime;
        }
        return 0;
    }

    set currentTime(seconds) {
        if (this._mediaElement) {
            this._mediaElement.currentTime = seconds;
        } else {
            this._pendingSeekTime = seconds;
        }
    }

}

export default BasePlayer;