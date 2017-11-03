import * as http from "http";
import * as util from "util";
import * as core from "../core";
import * as socketIo from "./socketIoServer";
import * as ws from "./wsServer";

export type RequestListener = (request: http.IncomingMessage, response: http.ServerResponse) => void;

export class HttpServer implements core.IHttpServer {
    constructor(private server: http.Server) {
    }

    public async close(): Promise<void> {
        await util.promisify(((callback) => this.server.close(callback)) as Function)();
    }

    public listen(port: any) {
        this.server.listen(port);
    }

    public on(event: string, listener: (...args: any[]) => void) {
        this.server.on(event, listener);
    }

    public address(): { port: number; family: string; address: string; } {
        return this.server.address();
    }
}

export class WebServer implements core.IWebServer {
    constructor(public httpServer: HttpServer, public webSocketServer: core.IWebSocketServer) {
    }

    /**
     * Closes the web server
     */
    public async close(): Promise<void> {
        await Promise.all([this.httpServer.close(), this.webSocketServer.close()]);
    }
}

export class SocketIoWebServerFactory implements core.IWebServerFactory {
    constructor(private redisConfig: any) {
    }

    public create(requestListener: RequestListener): core.IWebServer {
        // Create the base HTTP server and register the provided request listener
        const server = http.createServer(requestListener);
        const httpServer = new HttpServer(server);

        const socketIoServer = socketIo.create(this.redisConfig, server);

        return new WebServer(httpServer, socketIoServer);
    }
}

export class WsWebServerFactory implements core.IWebServerFactory {
    constructor() {
        //
    }

    public create(requestListener: RequestListener): core.IWebServer {
        // Create the base HTTP server and register the provided request listener
        const server = http.createServer(requestListener);
        const httpServer = new HttpServer(server);
        // httpServer.listen(3000);

        const wsServer = ws.create(server);

        return new WebServer(httpServer, wsServer);
    }
}
