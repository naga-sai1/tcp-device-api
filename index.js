const express = require("express");
const cors = require("cors");
const app = express();
const net = require("net");
const crypto = require("crypto");
const admin = require("firebase-admin");
const dotenv = require("dotenv");

// Load environment variables
dotenv.config();

// Production configurations
const isProd = process.env.NODE_ENV === 'production';
const HOST = process.env.HOST || '0.0.0.0'; 
const HTTP_PORT = process.env.HTTP_PORT || 3030;
const TCP_PORT = process.env.TCP_PORT || 8000;

// Enhanced error handling
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Optionally notify your error tracking service here
});

// Enhanced logging for production
function logInfo(message, ...args) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] INFO: ${message}`, ...args);
}

function logError(message, ...args) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ERROR: ${message}`, ...args);
}

const serviceAccount = require(process.env.FIREBASE_KEY_PATH);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// Middleware for parsing JSON
app.use(express.json());
app.use(cors());

// generate a unique id for the device limit must be 6 characters only alphabets
function generateUniqueId() {
  const characters = "abcdefghijklmnopqrstuvwxyz";
  let uniqueId = "";
  for (let i = 0; i < 6; i++) {
    uniqueId += characters[Math.floor(Math.random() * characters.length)];
  }
  return uniqueId;
}

// Express HTTP Route
app.get("/", (req, res) => {
  res.send("Hello, this is a TCP protocol server running alongside HTTP!");
});

// app.get("/tcp", async (req, res) => {
//   const tcpData = await db.collection('device').doc('yfRWw3YsyvxkNOOKyBG5').collection('device').get();
//   res.json(tcpData);
// });

// app.post("/create", async (req, res) => {
//   const data = req.body;
//   await db.collection('device').doc('yfRWw3YsyvxkNOOKyBG5').collection('device').add({ data });
//   res.send({ msg: "User Added" });
// });

// Store connected clients
const connectedClients = new Map();

// Function to send message to a specific client
function sendMessageToClient(targetAddress, message) {
  const client = connectedClients.get(targetAddress);
  if (client) {
    client.write(message + '\r\n');
    console.log(`Message sent to ${targetAddress}: ${message}`);
    return true;
  }
  console.log(`Client ${targetAddress} not found or not connected`);
  return false;
}

// Modify the server creation with enhanced error handling
const server = net.createServer()
    .on('error', (err) => {
        logError('TCP Server error:', err);
        if (err.code === 'EADDRINUSE') {
            logError(`Port ${TCP_PORT} is already in use`);
            process.exit(1);
        }
    });

// Enhance connection handling
server.on("connection", (socket) => {
    const remoteAddress = socket.remoteAddress + ":" + socket.remotePort;
    logInfo("New client connection from %s", remoteAddress);
    
    // Set keep-alive for production
    socket.setKeepAlive(true, 60000); // 60 seconds
    
    // Set timeout
    socket.setTimeout(300000); // 5 minutes timeout
    
    socket.on('timeout', () => {
        logInfo(`Connection from ${remoteAddress} timed out`);
        socket.end();
    });

    // Store the connected client
    connectedClients.set(remoteAddress, socket);

    socket.on("data", async (data) => {
      const receivedData = data.toString();
      console.log("Data received: %s", receivedData);

      const sanitizedData = receivedData.replace(/\\r\\n$/, "\r\n");
      console.log("Sanitized data: %s", sanitizedData);

      const match = sanitizedData.match(
        /^dr:([^:]+):([^:]+):([^:]+):([^:]+):([^:]+):([^:]+)\r\n$/i
      );

      if (match) {
        const [
          _,
          macId,
          deviceType,
          noOfSwitches,
          versionOfSoftware,
          versionOfHardware,
          defaultDeviceId,
        ] = match;

        console.log(
          "Parsed Data -> macId: %s, deviceType: %s, noOfSwitches: %s, versionOfSoftware: %s, versionOfHardware: %s, defaultDeviceId: %s",
          macId,
          deviceType,
          noOfSwitches,
          versionOfSoftware,
          versionOfHardware,
          defaultDeviceId
        );

        // generate a unique id for the device limit must be 6 characters only alphabets
        const uniqueId = generateUniqueId();

        const timestamp = Date.now();

        try {
          // Check if the device already exists
          const deviceQuery = await db
            .collection("device")
            // .where("macId", "==", macId)
            // .where("deviceType", "==", deviceType)
            // .where("noOfSwitches", "==", noOfSwitches)
            // .where("versionOfSoftware", "==", versionOfSoftware)
            // .where("versionOfHardware", "==", versionOfHardware)
            .where("defaultDeviceId", "==", defaultDeviceId)
            .limit(1) // Optimize query
            .get();

          if (!deviceQuery.empty) {
            console.log("Device already exists.");
            const existingDevice = deviceQuery.docs[0].data();
            const response = `DR:${uniqueId}:${existingDevice.serialNumber}:${timestamp}\r\n`;
            socket.write(response);
            return; // Exit to avoid further processing
          }

          // Generate a serial number using Firestore transaction
          const serialNumber = await db.runTransaction(async (transaction) => {
            const counterRef = db.collection("device").doc("serialNumberCounter");
            const counterDoc = await transaction.get(counterRef);

            let counterValue = 10000000;
            if (counterDoc.exists) {
              counterValue = counterDoc.data().counter;
            }

            // Increment the counter
            counterValue++;

            // Update the counter in Firestore
            transaction.set(counterRef, { counter: counterValue });

            // Return the padded serial number
            return counterValue.toString();
          });

          console.log("serialNumber: %s", serialNumber);

          // Store new device data
          await db.collection("device").doc(uniqueId).set({
            macId,
            deviceType,
            noOfSwitches,
            versionOfSoftware,
            versionOfHardware,
            defaultDeviceId,
            // timestamp,
            serialNumber,
            // uniqueId,
            remoteAddress,
          });

          console.log("Stored data for ID: %s in Firestore", uniqueId);

          const response = `DR:${uniqueId}:${serialNumber}:${timestamp}\r\n`;
          socket.write(response);
        } catch (error) {
          console.error("Error in transaction or storing data: ", error);
          socket.write("ERROR:DB_WRITE_FAILED\r\n");
        }
      } else {
        console.error("Invalid data format: %s", receivedData);
        socket.write("ERROR:INVALID_FORMAT\r\n");
      }
    });

    socket.once("close", (hadError) => {
        logInfo("Connection from %s closed %s", remoteAddress, hadError ? 'due to error' : 'normally');
        connectedClients.delete(remoteAddress);
    });

    socket.on("error", (err) => {
        logError("Connection error with %s: %s", remoteAddress, err.message);
    });
});

// Add new endpoint to send message to a specific client
app.post("/send-message", (req, res) => {
  const { targetAddress, message } = req.body;
  
  if (!targetAddress || !message) {
    return res.status(400).json({ error: "Target address and message are required" });
  }

  const sent = sendMessageToClient(targetAddress, message);
  if (sent) {
    res.json({ success: true, message: "Message sent successfully" });
  } else {
    res.status(404).json({ success: false, message: "Client not found or disconnected" });
  }
});

// Add endpoint to get all connected clients
app.get("/connected-clients", (req, res) => {
  const clients = Array.from(connectedClients.keys());
  res.json({ 
    connectedClients: clients,
    count: clients.length 
  });
});

// Enhanced HTTP server start
const httpServer = app.listen(HTTP_PORT, HOST, () => {
    logInfo(`HTTP server running at http://${HOST}:${HTTP_PORT}`);
});

httpServer.on('error', (err) => {
    logError('HTTP Server error:', err);
    if (err.code === 'EADDRINUSE') {
        logError(`Port ${HTTP_PORT} is already in use`);
        process.exit(1);
    }
});

// Enhanced TCP server start
server.listen(TCP_PORT, HOST, () => {
    logInfo(`TCP server listening on ${HOST}:${TCP_PORT}`);
});
