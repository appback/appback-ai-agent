const { EventEmitter } = require('events')

class EventBus extends EventEmitter {
  constructor() {
    super()
    this.setMaxListeners(50)
  }
}

module.exports = EventBus
