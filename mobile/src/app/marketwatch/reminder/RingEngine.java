package app.marketwatch.reminder;

/** Pure timing state machine; wall clock supplied by caller for restart persistence. */
public final class RingEngine {
    public boolean ringing, exhausted, quiet;
    public int count;
    public long nextAt;
    public boolean tick(long now, boolean isQuiet, int ringSeconds, int pauseSeconds, int maximum) {
        if (exhausted) return false;
        if (isQuiet) { quiet=true; ringing=false; nextAt=now; return false; }
        if (quiet) { quiet=false; nextAt=now; }
        if (now < nextAt) return ringing;
        if (ringing) {
            ringing=false;
            if (maximum>0 && count>=maximum) exhausted=true;
            else nextAt=now+pauseSeconds*1000L;
        } else if (maximum>0 && count>=maximum) { exhausted=true; }
        else { ringing=true; count++; nextAt=now+ringSeconds*1000L; }
        return ringing;
    }
    public void acknowledge() {ringing=false;exhausted=true;}
}
