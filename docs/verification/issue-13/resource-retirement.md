# Issue #13 验收资源归档退役

Ubuntu本机Docker，2026-10-07。r6已真实dump/restore校验所有业务schema的行数和内容，随后退役；历史9个已结束/被替代的验收project正在串行执行相同流程。执行计划见 `results/resource-retirement/historical-retirement-plan.json`，每个project终态报告包含私有归档位置、备份SHA256及全schema内容指纹。私有dump、角色和env不提交。共享依赖镜像保留。完成后更新总审计，不把运行中项目称已退役。
