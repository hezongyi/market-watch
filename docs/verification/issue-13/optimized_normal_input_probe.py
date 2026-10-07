"""Additional continuous-input window; does not replace the stale/recovery run."""

import os

os.environ['ISSUE13_NORMAL_INPUT'] = '1'

from optimized_observation_alert_probe import main

if __name__ == '__main__':
    main()
