import app.marketwatch.reminder.RingEngine;
public class RingEngineTest {
    static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
    public static void main(String[] args){
        RingEngine e=new RingEngine();
        check(e.tick(0,false,15,30,0),"starts ringing");
        check(e.tick(14999,false,15,30,0),"rings for 15 seconds");
        check(!e.tick(15000,false,15,30,0),"stops at 15s");
        check(!e.tick(44999,false,15,30,0),"30 second silent interval");
        check(e.tick(45000,false,15,30,0),"second ring at45s");
        e.acknowledge();check(!e.tick(60000,false,15,30,0),"ack stops forever");
        e=new RingEngine();e.tick(0,false,15,30,2);e.tick(15000,false,15,30,2);e.tick(45000,false,15,30,2);e.tick(60000,false,15,30,2);
        check(e.exhausted&&e.count==2,"maximum counts rings");
        check(!e.tick(90000,false,15,30,2),"exhausted stays silent");
        e=new RingEngine();e.tick(0,false,15,30,0);check(!e.tick(1000,true,15,30,0),"quiet interrupts ring");
        check(!e.tick(9000,true,15,30,0),"quiet stays silent");check(e.tick(10000,false,15,30,0),"quiet end resumes");
        e=new RingEngine();e.count=1;e.ringing=false;e.nextAt=45000;check(!e.tick(30000,false,15,30,0),"restored pause persists");check(e.tick(45000,false,15,30,0),"restored alarm resumes");
        System.out.println("RingEngine: cadence, max count, quiet interruption, acknowledgement and restored timing passed");
    }
}
