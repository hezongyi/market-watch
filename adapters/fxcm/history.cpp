// Demand-driven ForexConnect history only. Credentials and commands use stdin.
#include <poll.h>
#include <unistd.h>
#include <cstdio>
#include <ext/stdio_filebuf.h>
#include <algorithm>
#include <ForexConnect.h>
#include <atomic>
#include <chrono>
#include <iomanip>
#include <map>
#include <sstream>
#include <stdexcept>
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
using namespace std::chrono_literals;
class SessionObserver final : public IO2GSessionStatus {
    std::atomic<long> refs{1};
public:
    std::mutex mutex;
    std::condition_variable changed;
    bool connected = false, failed = false, disconnected = false;
    std::vector<int> events;
    long addRef() override { return ++refs; }
    long release() override { auto n=--refs; if (!n) delete this; return n; }
    void onSessionStatusChanged(O2GSessionStatus status) override {
        std::lock_guard<std::mutex> lock(mutex);
        events.push_back(int(status));
        connected = status == Connected;
        disconnected = status == Disconnected;
        if (status == TradingSessionRequested || status == ConnectedWithNeedToChangePassword || status == SessionLost) failed = true;
        changed.notify_all();
    }
    void onLoginFailed(const char*) override {
        // Never echo upstream error text that could contain an account identifier.
        std::lock_guard<std::mutex> lock(mutex);
        failed = true;
        changed.notify_all();
    }
    bool waitConnected() {
        std::unique_lock<std::mutex> lock(mutex);
        changed.wait_for(lock, 45s, [&] { return connected || failed; });
        return connected && !failed;
    }
    void waitDisconnected() {
        std::unique_lock<std::mutex> lock(mutex);
        changed.wait_for(lock, 5s, [&] { return disconnected; });
    }
};
class Responses final : public IO2GResponseListener {
    std::atomic<long> refs{1};
    IO2GSession* session;
    std::mutex requestMutex;
    std::condition_variable requestChanged;
    std::string pending;
    IO2GResponse* response = nullptr;
    bool requestFailed = false;
public:
    std::atomic<int> updates{0}, offers{0}, accounts{0}, trades{0}, other{0};
    explicit Responses(IO2GSession* value) : session(value) {}
    long addRef() override { return ++refs; }
    long release() override { auto n=--refs; if (!n) delete this; return n; }
    ~Responses() { if (response) response->release(); }
    void onRequestCompleted(const char* id, IO2GResponse* value) override {
        std::lock_guard<std::mutex> lock(requestMutex);
        if (id && pending == id && value) {
            if (response) response->release();
            value->addRef(); response = value; requestChanged.notify_all();
        }
    }
    void onRequestFailed(const char* id, const char*) override {
        std::lock_guard<std::mutex> lock(requestMutex);
        if (id && pending == id) { requestFailed=true; requestChanged.notify_all(); }
    }
    IO2GResponse* request(IO2GRequest* request) {
        if (!request) throw std::runtime_error("request_creation_failed");
        {
            std::lock_guard<std::mutex> lock(requestMutex);
            if (response) { response->release(); response=nullptr; }
            pending=request->getRequestID(); requestFailed=false;
        }
        session->sendRequest(request);
        std::unique_lock<std::mutex> lock(requestMutex);
        if (!requestChanged.wait_for(lock,15s,[&]{return response || requestFailed;}))
            throw std::runtime_error("request_timeout");
        if (requestFailed) throw std::runtime_error("request_failed");
        response->addRef(); return response;
    }
    void onTablesUpdates(IO2GResponse* update) override {
        ++updates;
        O2G2Ptr<IO2GResponseReaderFactory> factory = session->getResponseReaderFactory();
        if (!factory || !update) { ++other; return; }
        O2G2Ptr<IO2GTablesUpdatesReader> reader = factory->createTablesUpdatesReader(update);
        if (!reader) { ++other; return; }
        for (int i=0; i<reader->size(); ++i) {
            auto table=reader->getUpdateTable(i);
            if (table==Offers) ++offers;
            else if (table==Accounts) ++accounts;
            else if (table==Orders || table==Trades || table==ClosedTrades) ++trades;
            else ++other;
        }
    }
};

static std::string iso(DATE date) {
    SYSTEMTIME t{};
    if (!CO2GDateUtils::OleTimeToWindowsTime(date,&t)) return "invalid";
    std::ostringstream out;
    out << std::setfill('0') << std::setw(4) << t.wYear << '-' << std::setw(2) << t.wMonth
        << '-' << std::setw(2) << t.wDay << 'T' << std::setw(2) << t.wHour << ':'
        << std::setw(2) << t.wMinute << ':' << std::setw(2) << t.wSecond << 'Z';
    return out.str();
}
static std::string decimal(double value, int digits) {
    std::ostringstream out; out << std::fixed << std::setprecision(digits) << value; return out.str();
}
static std::string jsonString(const std::string& value) {
    std::ostringstream out;
    out << '"';
    for(unsigned char c : value) {
        if(c == '"' || c == '\\') out << '\\' << c;
        else if(c < 32) out << "\\u00" << std::hex << std::setfill('0') << std::setw(2) << int(c);
        else out << c;
    }
    out << '"';
    return out.str();
}

int main() {
    // Keep SDK diagnostics out of the protocol and caller logs. SDK files are
    // confined by the caller to a private temporary working directory.
    int output=dup(STDOUT_FILENO);
    freopen("/dev/null","w",stdout);
    freopen("/dev/null","w",stderr);
    __gnu_cxx::stdio_filebuf<char> buffer(output,std::ios::out);
    std::ostream protocol(&buffer);
    auto emit=[&](const std::string& value) { protocol << value << std::endl; };
    // Disable stdio prefetch so poll observes each pending protocol command.
    std::ios::sync_with_stdio(true);
    setvbuf(stdin,nullptr,_IONBF,0);
    std::string user,password,url,connection;
    for(auto* field:{&user,&password,&url,&connection})
        if(!std::getline(std::cin,*field) || field->empty()) return 2;
    if(url!="https://www.fxcorporate.com/Hosts.jsp" || connection!="Demo") return 2;
    auto* session=CO2GTransport::createSession();
    if(!session) return 2;
    session->useTableManager(No,nullptr);
    session->setPriceUpdateMode(NoPrice);
    session->setRequestsTimeout(15000);
    auto* status=new SessionObserver();
    auto* responses=new Responses(session);
    session->subscribeSessionStatus(status);
    session->subscribeResponse(responses);
    bool accepted=session->login(user.c_str(),password.c_str(),url.c_str(),connection.c_str());
    std::fill(user.begin(),user.end(),'\0'); std::fill(password.begin(),password.end(),'\0');
    bool connected=accepted && status->waitConnected();
    emit(connected?"{\"kind\":\"ready\"}":"{\"kind\":\"error\",\"code\":\"auth\"}");
    if(connected) {
        O2G2Ptr<IO2GRequestFactory> factory=session->getRequestFactory();
        O2G2Ptr<IO2GResponseReaderFactory> readers=session->getResponseReaderFactory();
        auto lastRequest=std::chrono::steady_clock::now()-1s;
        std::string command;
        while(factory && readers) {
            // No request, refresh or price subscription is performed while idle.
            pollfd descriptor{STDIN_FILENO,POLLIN,0};
            if(poll(&descriptor,1,20000)<=0 || !std::getline(std::cin,command)) break;
            try {
                if(responses->offers || responses->accounts || responses->trades || responses->other)
                    throw std::runtime_error("unsolicited_data");
                if(session->getPriceUpdateMode()!=NoPrice || session->getTableManager()!=nullptr)
                    throw std::runtime_error("invalid_session_mode");
                std::this_thread::sleep_until(lastRequest+1s);
                lastRequest=std::chrono::steady_clock::now();
                if(command=="catalog") {
                    O2G2Ptr<IO2GLoginRules> rules=session->getLoginRules();
                    O2G2Ptr<IO2GResponse> reply=rules->isTableLoadedByDefault(Offers)
                        ? rules->getTableRefreshResponse(Offers):nullptr;
                    if(!reply) {
                        O2G2Ptr<IO2GRequest> request=factory->createRefreshTableRequest(Offers);
                        reply=responses->request(request);
                    }
                    O2G2Ptr<IO2GOffersTableResponseReader> offers=readers->createOffersTableReader(reply);
                    if(!offers) throw std::runtime_error("invalid_directory");
                    for(int i=0;i<offers->size();++i) {
                        O2G2Ptr<IO2GOfferRow> row=offers->getRow(i);
                        if(!row || !row->isInstrumentValid() || !row->isDigitsValid()) continue;
                        std::ostringstream value;
                        value << "{\"kind\":\"instrument\",\"symbol\":" << jsonString(row->getInstrument())
                              << ",\"digits\":" << row->getDigits() << ",\"instrument_type\":" << int(row->getInstrumentType()) << '}';
                        emit(value.str());
                    }
                } else if(command=="timeframes") {
                    O2G2Ptr<IO2GTimeframeCollection> frames=factory->getTimeFrameCollection();
                    if(!frames) throw std::runtime_error("invalid_frames");
                    for(int i=0;i<frames->size();++i) {
                        O2G2Ptr<IO2GTimeframe> frame=frames->get(i);
                        std::ostringstream value;
                        value << "{\"kind\":\"timeframe\",\"id\":" << jsonString(frame->getID())
                              << ",\"query_depth\":" << frame->getQueryDepth() << '}';
                        emit(value.str());
                    }
                } else if(command=="bars") {
                    std::string symbol,frameId,args;
                    if(!std::getline(std::cin,symbol) || !std::getline(std::cin,frameId) || !std::getline(std::cin,args)) break;
                    int digits,count; double from,to;
                    std::istringstream input(args);
                    if(!(input>>digits>>from>>to>>count) || digits<0 || digits>10 || count<1 || count>300
                        || from<0 || to<=from || (frameId!="m1" && frameId!="m5" && frameId!="m15" && frameId!="m30" && frameId!="H1" && frameId!="H4" && frameId!="D1" && frameId!="W1" && frameId!="M1"))
                        throw std::runtime_error("invalid_request");
                    O2G2Ptr<IO2GTimeframeCollection> frames=factory->getTimeFrameCollection();
                    O2G2Ptr<IO2GTimeframe> frame=frames->get(frameId.c_str());
                    if(!frame || count>frame->getQueryDepth()) throw std::runtime_error("invalid_frame");
                    O2G2Ptr<IO2GRequest> request=factory->createMarketDataSnapshotRequestInstrument(symbol.c_str(),frame,count);
                    factory->fillMarketDataSnapshotRequestTime(request,from,to,false);
                    O2G2Ptr<IO2GResponse> reply=responses->request(request);
                    O2G2Ptr<IO2GMarketDataSnapshotResponseReader> bars=readers->createMarketDataSnapshotReader(reply);
                    if(!bars || !bars->isBar() || bars->size()>count) throw std::runtime_error("invalid_bars");
                    for(int i=0;i<bars->size();++i) {
                        std::ostringstream value;
                        value << "{\"kind\":\"candle\",\"time\":" << std::quoted(iso(bars->getDate(i)))
                              << ",\"open\":" << std::quoted(decimal(bars->getBidOpen(i),digits))
                              << ",\"high\":" << std::quoted(decimal(bars->getBidHigh(i),digits))
                              << ",\"low\":" << std::quoted(decimal(bars->getBidLow(i),digits))
                              << ",\"close\":" << std::quoted(decimal(bars->getBidClose(i),digits))
                              << ",\"volume\":" << bars->getVolume(i) << '}';
                        emit(value.str());
                    }
                } else throw std::runtime_error("invalid_operation");
                if(responses->offers || responses->accounts || responses->trades || responses->other)
                    throw std::runtime_error("unsolicited_data");
                emit("{\"kind\":\"done\"}");
            } catch(...) { emit("{\"kind\":\"error\",\"code\":\"request_failed\"}"); break; }
        }
    }
    session->logout(); status->waitDisconnected();
    session->unsubscribeResponse(responses); session->unsubscribeSessionStatus(status);
    responses->release(); status->release(); session->release();
    return connected?0:2;
}
