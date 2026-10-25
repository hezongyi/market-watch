import "./mobile-chart-document.js";

declare global {
  var MWMobileChartDocument: {
    directory(document: any): {original_index:number;original_chart_id:string|null;symbol:string;resolution:string}[];
    project(document: any, index: number): any;
    merge(document: any, index: number, single: any): any;
  };
}
export const mobileChartDocument = globalThis.MWMobileChartDocument;
