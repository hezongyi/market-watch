import { useState } from "react";
import type { Profile } from "./cache";
import { Button } from "./components/ui/button";
import { FieldGroup } from "./components/ui/field";
import { DataFeedback, DataInput, DataMore, DataSelect } from "./DataFormParts";
import { dataSources, useDataCommand } from "./dataOperations";

export default function DataSourceTools({
  profile,
  online,
  changed,
}: {
  profile: Profile;
  online: boolean;
  changed(): void;
}) {
  const [source, setSource] = useState("dukascopy");
  const [market, setMarket] = useState("a");
  const [symbol, setSymbol] = useState("");
  const command = useDataCommand(profile, online);
  const [action, setAction] = useState<"refresh" | "discover">();
  return (
    <DataMore title="更新目录与补录">
      <FieldGroup>
        <DataSelect
          label="更新来源"
          value={source}
          onChange={setSource}
          disabled={command.busy}
          items={dataSources.filter((item) => item.value !== "all")}
        />
        {source === "akshare" && (
          <DataSelect
            label="更新市场"
            value={market}
            onChange={setMarket}
            items={[
              { value: "a", label: "沪深 A 股" },
              { value: "hk", label: "港股" },
              { value: "futures", label: "主力连续期货" },
            ]}
          />
        )}
        <Button
          variant="outline"
          disabled={!online || command.busy}
          onClick={() => {
            setAction("refresh");
            void command.run(async (request) => {
              const result = await request<{
                partitions?: { status: string }[];
              }>(
                profile,
                `/market-data/history-catalog/refresh?market=${market}`,
                { source },
              );
              changed();
              if (result.partitions?.some((item) => item.status === "failed")) {
                command.setError(
                  "部分目录未能完整更新，已保留原目录；可查看来源状态，或用准确代码补录。",
                );
              } else command.setNotice("目录已更新");
            });
          }}
        >
          {command.busy && action === "refresh"
            ? "正在处理…"
            : command.notice && action === "refresh"
              ? "已更新"
              : "更新目录"}
        </Button>
        {source === "yahoo" && (
          <>
            <DataInput
              label="Yahoo 准确代码"
              value={symbol}
              onChange={(event) => setSymbol(event.target.value)}
            />
            <Button
              variant="outline"
              disabled={!online || command.busy || !symbol.trim()}
              onClick={() => {
                setAction("discover");
                void command.run(async (request) => {
                  await request(profile, "/market-data/catalog/discover", {
                    symbol: symbol.trim(),
                  });
                  changed();
                  command.setNotice("品种已补录，可返回搜索添加");
                });
              }}
            >
              {command.busy && action === "discover"
                ? "正在验证…"
                : command.notice && action === "discover"
                  ? "已补录"
                  : "验证并补录代码"}
            </Button>
          </>
        )}
      </FieldGroup>
      <DataFeedback error={command.error} />
    </DataMore>
  );
}
