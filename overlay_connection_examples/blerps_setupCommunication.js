const ACTION_TYPES = {
    UPDATE_SOURCE: "UPDATE_SOURCE",
    PLAY_ALERT: "PLAY_ALERT",
    PLAY_AUDIO: "PLAY_AUDIO",
    PLAY_VIDEO: "PLAY_VIDEO",
    PLAY_EMOTE: "PLAY_EMOTE",
    PLAY_EXPERIENCE: "PLAY_EXPERIENCE",
    SKIP_ALERT: "SKIP_ALERT",
    STOP_ALERT: "STOP_ALERT",
    PAUSE_ALERT: "PAUSE_ALERT",
    RESUME_ALERT: "RESUME_ALERT",
};

const logDivs = (message) => {
    if (window.location.hash === "#verbose") {
        console.error(message);
        // Create the div element
        const newDiv = document.createElement("div");

        // Add content to the div (optional)
        newDiv.textContent = message;
        newDiv.style.color = "white";
        newDiv.style.backgroundColor = "black";
        newDiv.style.fontSize = "40px";

        // Append the div to the body
        const logContainer = document.getElementById("log-container");
        if (!logContainer) {
            const newLogContainer = document.createElement("div");
            newLogContainer.id = "log-container";
            newLogContainer.style.position = "absolute";
            document.body.appendChild(newLogContainer);
            newLogContainer.appendChild(newDiv);
            return;
        }
        document.getElementById("log-container").prepend(newDiv);
    } else if (window.location.hash === "#log") {
        console.error(message);
    }
};

function generateUUID() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (
        c,
    ) {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

const SetupCommunication = (sourceType, onMessage) => {
    // const UUID = crypto.randomUUID(); // unused for now
    const UUID = generateUUID();

    console.log("SetupCommunication", sourceType, UUID);

    // check if service workers are supported
    if (typeof SharedWorker === "function") {
        // SERVICE WORKER SUPPORTED
        // initialize new working with serviceworker.js
        let simpleBrowserType =
            window.location.hash === "#vod" ? "vod" : "normal";
        let myWorker = null;
        if (!!SharedWorker) {
            try {
                myWorker = new SharedWorker("/static/service-worker.js");
                logDivs(`${sourceType} SharedWorker created`);
            } catch (error) {
                logDivs(`${sourceType} SharedWorker failed to create`);
                console.error(error);
            }
        }
        // worker.start the port ()
        myWorker.port.start();
        // worker.addEventListener("message", onMessage);
        myWorker.port.addEventListener("message", ({ data }) =>
            onMessage(JSON.parse(data)),
        );
        // worker.postMessage() // tell the worker we are here (type, sourceType, url?)
        myWorker.port.postMessage({
            type: "open_connection",
            source: sourceType,
            data: {
                url: window.location.href,
                UUID,
            },
        });

        const postMessage = (message) => {
            myWorker.port.postMessage(message);
        };

        const disconnect = () => {
            myWorker.port.postMessage({
                type: "close_connection",
                source: sourceType,
                data: {
                    UUID,
                },
            });
        };

        return { postMessage, disconnect };
    } else if (sourceType === "ROOT") {
        try {
            logDivs("CREATING ROOT");
            // ROOT AND BROADCASTCHANNEL
            console.log("ROOT AND BROADCASTCHANNEL");
            const connectedBrowsers = {
                ROOT: { [UUID]: { postMessage: onMessage } },
            };
            const broadcastChannels = {
                VOD: new BroadcastChannel("VOD"),
                ALERT: new BroadcastChannel("ALERT"),
                EMOTE: new BroadcastChannel("EMOTE"),
                EXPERIENCE: new BroadcastChannel("EXPERIENCE"),
                MEDIA: new BroadcastChannel("MEDIA"),
                PET: new BroadcastChannel("PET"),
            };

            //initialize for keeping track of connected browsers
            Object.keys(broadcastChannels).map((source) => {
                connectedBrowsers[source] = {};
            });

            const countSources = (source) =>
                connectedBrowsers[source]
                    ? Object.keys(connectedBrowsers[source]).length
                    : 0;

            // checks what sources are connected in the state machine
            const isSourceConnected = (source) => !!countSources(source);

            // a function that allows the controller to post messages to the browsers
            const postMessageFromController = (message) => {
                Object.values(connectedBrowsers[message.source])[0].postMessage(
                    message,
                );
            };

            // check to make sure setup controller is defined here and throw error if not??? idk
            const handleMessage = SetupController({
                postMessage: postMessageFromController,
                isSourceConnected,
                urlParam: window.location.href,
            });

            // a function that allows the root to send messages to the controller
            const postMessage = ({ source, type, data }) => {
                handleMessage({ source, type, data });
            };
            // tell the socket in the controller to disconnect
            const disconnect = () => {
                handleMessage({ source: "ROOT", type: "close_connection" });
            };

            Object.keys(broadcastChannels).map((source) => {
                const broadcastChannel = broadcastChannels[source];
                broadcastChannel.onmessage = ({ data: message }) => {
                    const { source, type, data } = message;
                    switch (type) {
                        case "open_connection":
                            connectedBrowsers[source][data.UUID] =
                                broadcastChannels[source]; // could just be "true"
                            // consider debug stuff here
                            console.log("connectedBrowsers", connectedBrowsers);
                            logDivs(
                                Object.keys(connectedBrowsers)
                                    .filter(isSourceConnected)
                                    .toString(),
                            );
                            return;
                        case "close_connection":
                            delete connectedBrowsers[source][data.UUID];
                            // consider debug stuff here
                            console.log("connectedBrowsers", connectedBrowsers);
                            logDivs(
                                Object.keys(connectedBrowsers)
                                    .filter(isSourceConnected)
                                    .toString(),
                            );
                            // logDivs(Object.keys(connectedBrowsers).toString());
                            return;
                        default:
                            handleMessage(message);
                            return;
                    }
                };

                broadcastChannel.postMessage({
                    source: source,
                    type: "who_is_connected",
                });
            });

            return { postMessage, disconnect };
        } catch (error) {
            logDivs(`${error} failed to create`);
        }
    }

    // SLAVE AND BROADCASTCHANNEL
    // initialize
    const recentMessages = new Set();

    // only deduplicate for the slaves where the case where multiple roots are connected and
    // sending duplicate messages to the slave via the broadcast channel
    // for messages that have duplicate transaction ids deduplicate them within a 100 second window
    const deduplicate = (message, onMessage) => {
        if (message && message.data && !message.data.transactionId) {
            onMessage(message);
            return;
        }

        const id = message.data.transactionId;

        if (recentMessages.has(id)) {
            console.error("Duplicate message", message);
            return;
        }

        recentMessages.add(id);

        setTimeout(() => {
            recentMessages.delete(id);
        }, 100 * 1000);

        onMessage(message);
    };

    // setup broadcast channel (sourceType)
    const broadcastChannel = new BroadcastChannel(sourceType);
    // a function that tells the root we are here so it can be added to the state machine
    const broadcastConnected = () => {
        broadcastChannel.postMessage({
            source: sourceType,
            type: "open_connection",
            data: {
                url: window.location.href,
                UUID,
            },
            // UUID: consider adding UUID here
        });
    };
    broadcastChannel.onmessage = ({ data: message }) => {
        // may need to pull out message from data field
        const { source, type, data } = message;
        switch (type) {
            case "who_is_connected":
                broadcastConnected();
                return;
            default:
                deduplicate(message, onMessage);
                return;
        }
    };
    broadcastConnected();
    const postMessage = (message) => {
        broadcastChannel.postMessage(message);
    };
    const disconnect = () => {
        broadcastChannel.postMessage({
            source: sourceType,
            type: "close_connection",
            data: {
                UUID,
            },
        });
    };
    return { postMessage, disconnect };
};
