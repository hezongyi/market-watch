# Original PAIO inputs

48 calculation and 18 host style inputs. Original source inventory is checked by test_all_original_inputs_registered.

| Key | Group | Default | Type / limits |
|---|---|---|---|
| gs_open_use | Gap Series | True | {'type': 'bool'} |
| gs_wick_use | Gap Series | True | {'type': 'bool'} |
| gs_body_use | Gap Series | True | {'type': 'bool'} |
| gs_wick_except_open | Gap Series | True | {'type': 'bool'} |
| gs_body_except_open | Gap Series | True | {'type': 'bool'} |
| gs_body_except_wick | Gap Series | True | {'type': 'bool'} |
| bi_use | Bar Index | True | {'type': 'bool'} |
| bi_timeframe | Bar Index | 1D | {'type': 'enum', 'options': ['1', '5', '15', '30', '60', '240', '1D', '1W', '1M']} |
| bi_from | Bar Index | 0 | {'type': 'integer', 'min': 0, 'max': 1000000} |
| bc_length | Bar Index | 999 | {'type': 'integer', 'min': 0, 'max': 1000000} |
| bi_step | Bar Index | 2 | {'type': 'integer', 'min': 0, 'max': 1000000} |
| bi_offset | Bar Index | 0 | {'type': 'integer', 'min': -1000000, 'max': 1000000} |
| bi_specific | Bar Index | 0,1 | {'type': 'text', 'max_length': 1024} |
| ma_1_use | Moving Average | True | {'type': 'bool'} |
| ma_1_length | Moving Average | 20 | {'type': 'integer', 'min': 1, 'max': 10000} |
| ma_1_offset | Moving Average | 0 | {'type': 'integer', 'min': -500, 'max': 500} |
| ma_1_timeframe | Moving Average | Chart | {'type': 'enum', 'options': ['Chart', '1', '5', '15', '30', '60', '240', '1D', '1W', '1M']} |
| ma_1_source | Moving Average | close | {'type': 'enum', 'options': ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'hlcc4']} |
| ma_2_use | Moving Average | True | {'type': 'bool'} |
| ma_2_length | Moving Average | 20 | {'type': 'integer', 'min': 1, 'max': 10000} |
| ma_2_offset | Moving Average | 0 | {'type': 'integer', 'min': -500, 'max': 500} |
| ma_2_timeframe | Moving Average | 15 | {'type': 'enum', 'options': ['Chart', '1', '5', '15', '30', '60', '240', '1D', '1W', '1M']} |
| ma_2_source | Moving Average | close | {'type': 'enum', 'options': ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'hlcc4']} |
| ma_3_use | Moving Average | True | {'type': 'bool'} |
| ma_3_length | Moving Average | 20 | {'type': 'integer', 'min': 1, 'max': 10000} |
| ma_3_offset | Moving Average | 0 | {'type': 'integer', 'min': -500, 'max': 500} |
| ma_3_timeframe | Moving Average | 60 | {'type': 'enum', 'options': ['Chart', '1', '5', '15', '30', '60', '240', '1D', '1W', '1M']} |
| ma_3_source | Moving Average | close | {'type': 'enum', 'options': ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'hlcc4']} |
| pvDisplay | Previous Values | All | {'type': 'enum', 'options': ['Today', 'TimeFrame', 'All']} |
| pvBaseChart | Previous Values | True | {'type': 'bool'} |
| pvLineDraw | Previous Values | True | {'type': 'bool'} |
| pv1stUse | Previous Values | True | {'type': 'bool'} |
| pv1stTF | Previous Values | 1D | {'type': 'enum', 'options': ['1', '5', '15', '30', '60', '240', '1D', '1W', '1M']} |
| pv1stSource | Previous Values | close | {'type': 'enum', 'options': ['close', 'high', 'low', 'open', 'hl/2', 'hlc3', 'ohlc/4', 'hlcc/4', 'CurrentOpen']} |
| pv1stWidth | Previous Values | 1 | {'type': 'integer', 'min': 1, 'max': 10} |
| pv2ndUse | Previous Values | True | {'type': 'bool'} |
| pv2ndTF | Previous Values | 1D | {'type': 'enum', 'options': ['1', '5', '15', '30', '60', '240', '1D', '1W', '1M']} |
| pv2ndSource | Previous Values | high | {'type': 'enum', 'options': ['close', 'high', 'low', 'open', 'hl/2', 'hlc3', 'ohlc/4', 'hlcc/4', 'CurrentOpen']} |
| pv2ndWidth | Previous Values | 1 | {'type': 'integer', 'min': 1, 'max': 10} |
| pv3rdUse | Previous Values | True | {'type': 'bool'} |
| pv3rdTF | Previous Values | 1D | {'type': 'enum', 'options': ['1', '5', '15', '30', '60', '240', '1D', '1W', '1M']} |
| pv3rdSource | Previous Values | low | {'type': 'enum', 'options': ['close', 'high', 'low', 'open', 'hl/2', 'hlc3', 'ohlc/4', 'hlcc/4', 'CurrentOpen']} |
| pv3rdWidth | Previous Values | 1 | {'type': 'integer', 'min': 1, 'max': 10} |
| useOO | I & O Bar | True | {'type': 'bool'} |
| useII | I & O Bar | True | {'type': 'bool'} |
| useIOI | I & O Bar | True | {'type': 'bool'} |
| useHLC | H & L Count | True | {'type': 'bool'} |
| HLCInterval | H & L Count | 1.0 | {'type': 'float', 'min': -100, 'max': 100} |
| gs_open_u_color | Gap Series | rgba(8,153,129,0.6) | style color |
| gs_open_d_color | Gap Series | rgba(242,54,69,0.6) | style color |
| gs_wick_u_color | Gap Series | rgba(8,153,129,0.4) | style color |
| gs_wick_d_color | Gap Series | rgba(242,54,69,0.4) | style color |
| gs_body_u_color | Gap Series | rgba(8,153,129,0.2) | style color |
| gs_body_d_color | Gap Series | rgba(242,54,69,0.2) | style color |
| bi_size | Bar Index | normal | style text |
| bi_color | Bar Index | #ff9800 | style color |
| pv1stColor | Previous Values | #434651 | style color |
| pv1stLine | Previous Values | dotted | style text |
| pv2ndColor | Previous Values | #F23645 | style color |
| pv2ndLine | Previous Values | dashed | style text |
| pv3rdColor | Previous Values | #089981 | style color |
| pv3rdLine | Previous Values | dashed | style text |
| ioLableSize | I & O Bar | large | style text |
| ioLableColor | I & O Bar | #787b86 | style color |
| HColor | H & L Count | #089981 | style color |
| LColor | H & L Count | #F23645 | style color |
